/**
 * The Coach screen's main thread on a mid-range phone (DevTools 4× CPU), the M5 plan's budget
 * ('a 60-message thread costs ≤ 200 ms, and ≤ 200 ms of blocking while an answer streams'):
 * - opening a 60-message conversation (30 questions and answers; the screen shows the newest
 *   THREAD_VIEW_MESSAGES): total blocking time over load + 1.5 s, median of 5 cold loads, target
 *   200 ms and guard 250 ms, measured exactly as perf.e2e.ts measures every screen;
 * - while a 3,000-token clean answer streams (the mock's 'perf-stream', faster than the real model):
 *   total blocking time from Send to the end of the answer ≤ 200 ms (median of STREAM_RUNS), and
 *   input to paint ≤ 100 ms (Event Timing INP over Send and the owner typing as it streams);
 * - the same answers' TTFT (agent_runs.ttft_ms) and first-text delay (Send to the first words on
 *   screen) are recorded, and the first words must arrive in the first quarter of the stream: the
 *   output gate's hold releases a clean answer as it arrives, never at its end.
 * Its own file in the perf project (playwright.config.ts), so perf.e2e.ts stays M3's. Never raise
 * a threshold without a measured reason recorded in docs/performance.md.
 */
import { expect, test, type Page } from '@playwright/test';
import { parseAnswer } from '../src/lib/domain/coach/answer';
import {
	PERF_STREAM_ANSWER,
	PERF_STREAM_TOKENS
} from '../src/lib/server/agent/provider/mock-scripts/test';
import {
	COACH_TZ,
	lastRun,
	openThread,
	ownerMessages,
	postTurn,
	query,
	resetCoach,
	seedCoach,
	setCoachFault
} from './coach-support';
import { inp } from './inp';

/** perf.e2e.ts's main-thread target and guard, for opening the long conversation. */
const BLOCKING_TARGET_MS = 200;
const BLOCKING_GUARD_MS = 250;
const LOADS = 5;
/** The conversation's questions: with their answers, 60 messages. */
const EXCHANGES = 30;
/** Total blocking time while the answer streams (the M5 plan's budget). */
const STREAM_BLOCKING_MS = 200;
/** Input to the next paint while the answer streams. */
const INPUT_TO_PAINT_MS = 100;
/** The answer's output tokens, at least. */
const STREAM_TOKENS = PERF_STREAM_TOKENS;
const STREAM_RUNS = 5;
/** Letters typed into the composer while each answer streams, one every TYPE_DELAY_MS. */
const TYPED = 'is my deadlift on track';
const TYPE_DELAY_MS = 120;
/** The first words show within this share of the whole stream. */
const FIRST_TEXT_SHARE = 0.25;

test.use({ timezoneId: COACH_TZ });

const composer = (page: Page) => page.getByRole('form', { name: 'Message your coach' });
const message = (page: Page) => composer(page).getByRole('textbox', { name: 'Message' });

const median = (values: number[]) => {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)]!;
};
const round = (ms: number) => Math.round(ms);

interface Streamed {
	sentAt: number | null;
	firstTextAt: number | null;
	tasks: { start: number; duration: number }[];
	interactions: { id: number; duration: number; start: number }[];
}

/**
 * In the page, from the start: long tasks and Event Timing interactions with their start times,
 * the press of Send (its pointerdown), and the first words of the live answer.
 */
function observeStream() {
	const state: Streamed = { sentAt: null, firstTextAt: null, tasks: [], interactions: [] };
	Object.assign(window, { __stream: state });
	new PerformanceObserver((list) => {
		for (const entry of list.getEntries())
			state.tasks.push({ start: entry.startTime, duration: entry.duration });
	}).observe({ type: 'longtask', buffered: true });
	new PerformanceObserver((list) => {
		for (const entry of list.getEntries() as PerformanceEventTiming[])
			if (entry.interactionId)
				state.interactions.push({
					id: entry.interactionId,
					duration: entry.duration,
					start: entry.startTime
				});
	}).observe({ type: 'event', durationThreshold: 16, buffered: true } as PerformanceObserverInit);
	document.addEventListener(
		'pointerdown',
		(event) => {
			// The input's own timestamp, as Event Timing and long tasks count time: the press's
			// handlers and paint fall inside the window that starts here.
			if ((event.target as Element).closest('button[aria-label="Send"]'))
				state.sentAt ??= event.timeStamp;
		},
		true
	);
	const words = () => {
		const live = document.querySelector('[data-testid="live-answer"]');
		// Only a draft's <p> holds streamed words; its kind label is there from the first event.
		const drafts = live?.querySelectorAll('[data-testid="answer-draft"] p') ?? [];
		const draft = [...drafts].some((p) => p.textContent?.trim());
		return draft || live?.querySelector('[data-testid="answer-block"]') != null;
	};
	const watch = () =>
		new MutationObserver(() => {
			if (state.sentAt !== null && state.firstTextAt === null && words())
				state.firstTextAt = performance.now();
		}).observe(document.body, { subtree: true, childList: true, characterData: true });
	if (document.body) watch();
	else document.addEventListener('DOMContentLoaded', watch);
}

test.describe('coach screen at 4× CPU', () => {
	test.skip(({ browserName }) => browserName !== 'chromium', 'CPU throttling uses CDP');
	test.afterAll(async ({ request }) => {
		await resetCoach(request);
	});

	test(`a 60-message conversation opens with ≤ ${BLOCKING_GUARD_MS} ms of main-thread blocking`, async ({
		browser,
		request
	}, testInfo) => {
		test.setTimeout(180_000);
		// long-thread's real turns, then real turns with multi-block answers up to 30 exchanges.
		const seeded = await seedCoach(request, 'long-thread');
		const thread = seeded.threads.long!;
		await setCoachFault(request, 'none', { script: 'long-answer' });
		for (let n = (await ownerMessages(thread)).length; n < EXCHANGES; n++) {
			const turn = await postTurn(
				request,
				`Question ${n + 1}: how should session ${n + 1} go?`,
				thread
			);
			expect(turn.status, `turn ${n + 1}`).toBe(200);
			expect(turn.events.at(-1), `turn ${n + 1}`).toEqual({ type: 'done', status: 'completed' });
		}
		await setCoachFault(request, 'none');
		expect(await ownerMessages(thread)).toHaveLength(EXCHANGES);

		const samples: number[] = [];
		for (let i = 0; i < LOADS; i++) {
			// A fresh context per load: cold caches, no service worker yet (as perf.e2e.ts).
			const context = await browser.newContext({ ...testInfo.project.use, timezoneId: COACH_TZ });
			const page = await context.newPage();
			await page.addInitScript(() => {
				const tasks: number[] = [];
				Object.assign(window, { __longTasks: tasks });
				new PerformanceObserver((list) => {
					for (const entry of list.getEntries()) tasks.push(entry.duration);
				}).observe({ type: 'longtask', buffered: true });
			});
			const cdp = await context.newCDPSession(page);
			await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
			await page.goto(`/coach/${thread}`, { waitUntil: 'load' });
			await page.waitForTimeout(1_500);
			const tasks = await page.evaluate(
				() => (window as unknown as { __longTasks: number[] }).__longTasks
			);
			samples.push(tasks.reduce((sum, d) => sum + Math.max(0, d - 50), 0));
			// The conversation's newest page is on screen: a full page of questions and answers.
			const shown = page.getByTestId('owner-message').or(page.getByTestId('coach-message'));
			await expect(shown).toHaveCount(30);
			await context.close();
		}
		const typical = median(samples);
		const status =
			typical <= BLOCKING_TARGET_MS ? 'meets target' : `above the ${BLOCKING_TARGET_MS} ms target`;
		testInfo.annotations.push({
			type: 'blocking time (ms)',
			description: `median ${round(typical)} (${status}) · runs ${samples.map(round).join(', ')}`
		});
		expect(
			typical,
			`60-message conversation: ${samples.map(round).join(', ')} ms`
		).toBeLessThanOrEqual(BLOCKING_GUARD_MS);
	});

	test(`a ${STREAM_TOKENS}-token answer streams with ≤ ${STREAM_BLOCKING_MS} ms of blocking, input paints in ≤ ${INPUT_TO_PAINT_MS} ms, and its first words come early`, async ({
		page,
		request
	}, testInfo) => {
		test.setTimeout(360_000);
		const seeded = await seedCoach(request, 'bench-month');
		const thread = seeded.threads.bench!;
		await setCoachFault(request, 'none', { script: 'perf-stream' });
		await page.addInitScript(observeStream);
		const cdp = await page.context().newCDPSession(page);
		await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });

		const blocking: number[] = [];
		const firstText: number[] = [];
		const ttft: number[] = [];
		const streams: number[] = [];
		const interactions: { id: string; duration: number }[] = [];
		let inputs = 0;
		for (let run = 0; run < STREAM_RUNS; run++) {
			// A fresh page each time: the live answer is this run's alone.
			await openThread(page, thread);
			await message(page).fill(`Give me the long version, take ${run + 1}`);
			await composer(page).getByRole('button', { name: 'Send' }).click();
			await expect(composer(page).getByRole('button', { name: 'Stop' })).toBeVisible();
			// The owner types the next question while the answer streams.
			await message(page).pressSequentially(TYPED, { delay: TYPE_DELAY_MS });
			await expect(composer(page).getByRole('button', { name: 'Send' })).toBeVisible({
				timeout: 60_000
			});
			const endAt = await page.evaluate(() => performance.now());
			const state = await page.evaluate(
				() => (window as unknown as { __stream: Streamed }).__stream
			);
			expect(state.sentAt, 'Send was pressed').not.toBeNull();
			expect(state.firstTextAt, 'the answer showed words').not.toBeNull();
			const sentAt = state.sentAt!;
			const during = state.tasks.filter((t) => t.start >= sentAt && t.start <= endAt);
			blocking.push(during.reduce((sum, t) => sum + Math.max(0, t.duration - 50), 0));
			firstText.push(state.firstTextAt! - sentAt);
			streams.push(endAt - sentAt);
			// interactionId is unique within a page only: key each by its run.
			for (const i of state.interactions)
				if (i.start >= sentAt && i.start <= endAt)
					interactions.push({ id: `${run}:${i.id}`, duration: i.duration });
			inputs += 1 + TYPED.length;
			const [row] = await query<{ status: string; ttft: number | null; tokens: number }>(
				'select status, ttft_ms as ttft, output_tokens::int as tokens from agent_runs where id = $1',
				[(await lastRun())!.id]
			);
			expect(row!.status).toBe('completed');
			expect(row!.tokens, 'the streamed answer is the long one').toBeGreaterThanOrEqual(
				STREAM_TOKENS
			);
			ttft.push(row!.ttft ?? Number.NaN);
			// It was the whole answer, every block on screen, nothing held back or replaced.
			await expect(page.getByTestId('live-answer').getByTestId('answer-block')).toHaveCount(
				parseAnswer(PERF_STREAM_ANSWER).length
			);
		}

		const eventInp = inp(interactions, inputs);
		testInfo.annotations.push(
			{
				type: 'blocking while streaming (ms)',
				description: `median ${round(median(blocking))} · runs ${blocking.map(round).join(', ')}`
			},
			{
				type: 'Event Timing INP while streaming (ms)',
				description: `${round(eventInp)} over ${inputs} interactions (${new Set(interactions.map((i) => i.id)).size} over 16 ms)`
			},
			{
				type: 'first-text delay (ms)',
				description: `median ${round(median(firstText))} · runs ${firstText.map(round).join(', ')} · streams ${streams.map(round).join(', ')}`
			},
			{
				type: 'TTFT (ms)',
				description: `median ${median(ttft)} · runs ${ttft.join(', ')}`
			}
		);

		expect(median(blocking), `blocking: ${blocking.map(round).join(', ')} ms`).toBeLessThanOrEqual(
			STREAM_BLOCKING_MS
		);
		expect(eventInp, 'input to paint while streaming').toBeLessThanOrEqual(INPUT_TO_PAINT_MS);
		for (const [i, delay] of firstText.entries())
			expect(
				delay,
				`run ${i + 1}: first words of a ${round(streams[i]!)} ms stream`
			).toBeLessThanOrEqual(streams[i]! * FIRST_TEXT_SHARE);
	});
});
