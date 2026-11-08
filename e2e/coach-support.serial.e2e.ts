/**
 * The coach specs' support (e2e/coach-support.ts) against the real server: every coach fixture
 * seeds through the test-only route in under a second at the server's dates and resets to
 * nothing, and every fault and scripted run answers a turn as configured. Serial: the faults
 * live in the one server's memory, and the coach rows are the one owner's.
 */
import { expect, test, type APIRequestContext } from '@playwright/test';
import { localDay } from '../src/lib/domain/dates';
import { SLOW_ANSWER, THINKING_PAUSE_MS } from '../src/lib/server/agent/provider/mock-scripts/test';
import {
	COACH_FIXTURES,
	LONG_THREAD_EXCHANGES
} from '../src/lib/server/test-support/coach-fixtures';
import {
	COACH_TZ,
	coachCounts,
	lastRun,
	ownerMessages,
	postTurn,
	query,
	resetCoach,
	seedCoach,
	setCoachFault,
	type CoachFault,
	type CoachFixture,
	type PostedTurn,
	type SeededCoach
} from './coach-support';
import { SAME_ORIGIN } from './support';

const ROUTE = '/api/test-support/coach';

test.use({ timezoneId: COACH_TZ });

/** Answered by the mock's greeting script: no tool, no lookup. */
const HELLO = 'Hello coach';
/** A lookup the server answers with no model call (domain/coach/intents.ts). */
const LOOKUP = "What's on this week?";

const types = (turn: PostedTurn) => turn.events.map((event) => event.type);
const errorOf = (turn: PostedTurn) => turn.events.find((event) => event.type === 'error');
const doneOf = (turn: PostedTurn) => turn.events.at(-1);
const textOf = (turn: PostedTurn) =>
	turn.events.map((event) => (event.type === 'text_delta' ? event.text : '')).join('');

test.beforeEach(async ({ request }) => {
	await resetCoach(request);
});

test.afterAll(async ({ request }) => {
	await resetCoach(request);
});

/** Seed `fixture` on a reset owner, timing the route alone. */
async function seedTimed(request: APIRequestContext, fixture: CoachFixture) {
	await resetCoach(request);
	const started = performance.now();
	const response = await request.post(ROUTE, {
		headers: SAME_ORIGIN,
		data: { fixture, timeZone: COACH_TZ }
	});
	const ms = performance.now() - started;
	expect(response.status(), fixture).toBe(201);
	return { seeded: (await response.json()) as SeededCoach, ms };
}

test('every fixture seeds in under a second at the server’s dates, and resets to nothing', async ({
	request
}) => {
	for (const fixture of COACH_FIXTURES) {
		const before = localDay(new Date(), COACH_TZ);
		const { seeded, ms } = await seedTimed(request, fixture);
		expect(ms, `${fixture} seeded in ${Math.round(ms)} ms`).toBeLessThan(1_000);
		expect(seeded.fixture).toBe(fixture);
		expect([before, localDay(new Date(), COACH_TZ)], fixture).toContain(seeded.today);
		await resetCoach(request);
		expect(await coachCounts(), `${fixture} reset`).toEqual({ threads: 0, messages: 0, runs: 0 });
		expect(await query('select id from workouts')).toEqual([]);
		expect(await query('select id from programs')).toEqual([]);
	}
});

test('the ids a seed answers are the stored rows’', async ({ request }) => {
	const long = await seedCoach(request, 'long-thread');
	expect(await ownerMessages(long.threads.long!)).toHaveLength(LONG_THREAD_EXCHANGES);

	const bench = await seedCoach(request, 'bench-month');
	const [cited] = await query<{ n: number }>(
		`select count(*)::int as n from coach_messages
		where thread_id = $1 and kind = 'assistant' and display::text like $2`,
		[bench.threads.bench, `%${bench.exercises.bench_press}%`]
	);
	expect(cited!.n).toBe(1);

	const archived = await seedCoach(request, 'archived-threads');
	const rows = await query<{ id: string }>(
		`select id::text from coach_threads where archived_at is not null order by id`
	);
	expect(rows.map((row) => row.id)).toEqual(Object.values(archived.threads).sort());
});

test('a seed on top of coach data is refused and writes nothing', async ({ request }) => {
	await seedCoach(request, 'unpriced-run');
	const before = await coachCounts();
	const again = await request.post(ROUTE, {
		headers: SAME_ORIGIN,
		data: { fixture: 'archived-threads', timeZone: COACH_TZ }
	});
	expect(again.status()).toBe(409);
	expect(await coachCounts()).toEqual(before);
});

test('each fault answers a turn as configured', async ({ request }) => {
	const answered = await postTurn(request, HELLO);
	expect(types(answered).slice(-2)).toEqual(['answer_completed', 'done']);

	const failing: [CoachFault, string][] = [
		['error', 'provider'],
		['overloaded', 'provider']
	];
	for (const [fault, kind] of failing) {
		await setCoachFault(request, fault);
		const turn = await postTurn(request, HELLO);
		expect(errorOf(turn), fault).toMatchObject({ type: 'error', kind });
		expect(doneOf(turn), fault).toEqual({ type: 'done', status: 'failed' });
	}

	await setCoachFault(request, 'rate_limited');
	const limited = await postTurn(request, HELLO);
	expect(limited.status).toBe(429);
	expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

	await setCoachFault(request, 'unavailable');
	const lookup = await postTurn(request, LOOKUP);
	expect(types(lookup).slice(-2)).toEqual(['answer_completed', 'done']);
	expect(errorOf(await postTurn(request, HELLO))).toEqual({
		type: 'error',
		kind: 'unavailable',
		reason: 'no_key'
	});

	for (const fault of ['not_launched', 'disabled'] as const) {
		await setCoachFault(request, fault);
		const before = await coachCounts();
		const turn = await postTurn(request, HELLO);
		expect(turn.events, fault).toEqual([
			{ type: 'error', kind: 'unavailable', reason: fault },
			{ type: 'done', status: null }
		]);
		expect(await coachCounts(), `${fault} writes nothing`).toEqual(before);
	}

	await setCoachFault(request, 'refusal');
	const refused = await postTurn(request, HELLO);
	expect(errorOf(refused)).toMatchObject({ kind: 'refused' });
	expect(doneOf(refused)).toEqual({ type: 'done', status: 'refused' });

	await setCoachFault(request, 'budget');
	const broke = await postTurn(request, HELLO);
	expect(errorOf(broke)).toMatchObject({ kind: 'budget' });
	expect(await lastRun()).toMatchObject({ status: 'budget_exhausted', error: 'daily_cap' });

	await resetCoach(request);
	expect(types(await postTurn(request, HELLO)).slice(-2)).toEqual(['answer_completed', 'done']);
});

test('scripted runs: slow, a shortened turn, a thinking pause and a long answer', async ({
	request
}) => {
	await setCoachFault(request, 'slow', { chunkDelayMs: 0 });
	const slow = await postTurn(request, HELLO);
	expect(doneOf(slow)).toEqual({ type: 'done', status: 'completed' });
	expect(textOf(slow)).toBe(SLOW_ANSWER.replace(/^\[note\] /, ''));

	await setCoachFault(request, 'slow', { turnMs: 1_000 });
	const timedOut = await postTurn(request, HELLO);
	expect(errorOf(timedOut)).toMatchObject({ kind: 'timeout' });
	expect(doneOf(timedOut)).toEqual({ type: 'done', status: 'timed_out' });

	await setCoachFault(request, 'none', { script: 'thinking-pause' });
	const started = performance.now();
	const paused = await postTurn(request, HELLO);
	expect(performance.now() - started).toBeGreaterThanOrEqual(THINKING_PAUSE_MS);
	expect(doneOf(paused)).toEqual({ type: 'done', status: 'completed' });

	await setCoachFault(request, 'none', { script: 'long-answer' });
	const long = await postTurn(request, HELLO);
	const blocks = long.events.filter((event) => event.type === 'block_completed');
	expect(blocks.length).toBeGreaterThanOrEqual(7);
	expect(doneOf(long)).toEqual({ type: 'done', status: 'completed' });
});
