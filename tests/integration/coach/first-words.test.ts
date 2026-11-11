/**
 * The coach's first words, sooner (owner decision 2026-11-11), on real Postgres through runTurn:
 * - a summary is made after the answer that leaves its segment due (TurnOptions.after), so the
 *   next turn rolls over with no summary call before its first words; without `after`, the
 *   summary still runs before them, as before
 * - a summary made ahead that failed is made again by the next turn, inline
 * - a send while the summary ahead is still running waits for it and uses it, never busy
 * - a short, general question that opens a conversation runs at low effort; the next question in
 *   the same segment at medium
 * First words are timed from the send to the first text delta, on the mock, whose summary call
 * takes SUMMARY_MS: the measured turn work is far below it, so the bounds hold on slow runners.
 */
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { SEGMENT } from '../../../src/lib/domain/coach/budgets';
import type { CoachEvent } from '../../../src/lib/domain/coach/events';
import { MockProvider, type MockScript } from '../../../src/lib/server/agent/provider/mock';
import { summaryScripts } from '../../../src/lib/server/agent/provider/mock-scripts/summaries';
import { CoachProviderError, type LlmProvider } from '../../../src/lib/server/agent/provider/types';
import { agentRuns, coachNotes, coachThreads, type Executor } from '../../../src/lib/server/db';
import { withCommitted, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';
import { recording, runScripted, storedRows } from './harness';

/** How long the mock's summary call takes before its first word. */
const SUMMARY_MS = 1000;
const OLD_ANSWER = '[note] Keep going as planned.';
const NEW_ANSWER = '[note] Here is where things stand.';

const answering = (text: string): MockScript => ({
	name: 'answer',
	matches: () => true,
	steps: [{ text, thinking: true }]
});
const slowSummaries: readonly MockScript[] = summaryScripts.map((script) => ({
	...script,
	steps: script.steps.map((step) => ({ ...step, firstDelayMs: SUMMARY_MS }))
}));

const ready = (provider: LlmProvider) => ({ status: 'ready' as const, provider });

/** A mock coach whose summary call is slow; `failFirst` makes its first summary call fail. */
function coach(text: string, { failFirst = false } = {}) {
	const provider = recording(
		new MockProvider([...slowSummaries, answering(text)], { overrides: () => ({}) })
	);
	const summarise = provider.structured;
	let structured = 0;
	return Object.assign(provider, {
		structuredCalls: () => structured,
		structured: ((request, schema, signal) => {
			structured += 1;
			if (failFirst && structured === 1)
				return Promise.reject(new CoachProviderError('overloaded', 'Overloaded'));
			return summarise(request, schema, signal);
		}) as LlmProvider['structured']
	});
}

const messageCount = (rows: readonly { kind: string }[]) =>
	rows.filter((row) => row.kind === 'owner_message' || row.kind === 'assistant').length;

/** Work handed to TurnOptions.after, kept to be awaited one at a time. */
function afterWork() {
	const pending: Promise<void>[] = [];
	return {
		after: (work: Promise<void>) => void pending.push(work),
		settled: async () => {
			while (pending.length > 0) await pending.shift();
		}
	};
}

interface Timed {
	events: CoachEvent[];
	runId: string | null;
	threadId: string | null;
	/** From the send to the first words, in milliseconds. */
	firstWordsMs: number | null;
}

async function timedTurn(
	options: Omit<Parameters<typeof runScripted>[1], 'onEvent'> & { text: string },
	script: MockScript
): Promise<Timed> {
	const sentAt = performance.now();
	let firstWordsMs: number | null = null;
	const turn = await runScripted(script, {
		...options,
		onEvent: (event) => {
			if (event.type === 'text_delta') firstWordsMs ??= performance.now() - sentAt;
		}
	});
	return { events: turn.events, runId: turn.runId, threadId: turn.threadId, firstWordsMs };
}

/**
 * Turns (no tools) until the conversation holds SEGMENT.messages messages. Each turn's work after
 * it is awaited before the next query, except the last turn's when `concurrent` (a pool, whose
 * connections may run together): the caller awaits it.
 */
async function fillSegment(
	db: Executor,
	owner: string,
	provider: ReturnType<typeof coach>,
	{
		after = true,
		concurrent = false,
		now
	}: { after?: boolean; concurrent?: boolean; now?: () => Date } = {}
) {
	const work = afterWork();
	let threadId: string | null = null;
	for (let n = 1; ; n += 1) {
		const turn = await runScripted(answering(OLD_ANSWER), {
			db,
			owner,
			threadId,
			tools: [],
			provider: ready(provider),
			text: `Old question ${n}`,
			...(now && { now }),
			...(after && { after: work.after })
		});
		threadId = turn.threadId!;
		if (!concurrent) await work.settled();
		if (messageCount(await storedRows(db, threadId)) >= SEGMENT.messages) break;
		await work.settled();
	}
	return { threadId: threadId!, work };
}

const runOf = async (db: Executor, id: string) =>
	(await db.select().from(agentRuns).where(eq(agentRuns.id, id)))[0]!;
const summaryRuns = (db: Executor, threadId: string) =>
	db
		.select()
		.from(agentRuns)
		.where(and(eq(agentRuns.threadId, threadId), eq(agentRuns.kind, 'summary')));
const chips = (events: readonly CoachEvent[]) =>
	events.filter((event) => event.type === 'activity');
const DONE_CHIP = {
	type: 'activity',
	id: 'summary_1',
	tool: 'summary',
	state: 'done',
	label: 'Summarised our earlier messages'
};

describe('first words sooner', () => {
	it('summarises after the answer that fills the segment, so the next turn starts with no summary call', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const old = coach(OLD_ANSWER);
			const { threadId, work } = await fillSegment(db, owner, old);
			await work.settled();
			expect(old.structuredCalls()).toBe(1);
			const [ahead] = await summaryRuns(db, threadId);
			expect(ahead).toMatchObject({ status: 'completed', effort: 'low', modelCalls: 1 });
			const segmentOne = await storedRows(db, threadId);
			const [note] = await db.select().from(coachNotes).where(eq(coachNotes.ownerId, owner));
			expect(note!.runId).toBe(ahead!.id);
			expect(note!.body).toMatchObject({
				threadId,
				segment: 1,
				throughSeq: segmentOne.at(-1)!.seq
			});

			const next = coach(NEW_ANSWER);
			const turn = await timedTurn(
				{ db, owner, threadId, tools: [], provider: ready(next), text: 'Where do things stand?' },
				answering(NEW_ANSWER)
			);

			expect(turn.events.at(-1)).toEqual({ type: 'done', status: 'completed' });
			expect(next.structuredCalls(), 'no summary call before the answer').toBe(0);
			expect(chips(turn.events)).toEqual([DONE_CHIP]);
			expect(turn.firstWordsMs).not.toBeNull();
			expect(turn.firstWordsMs!).toBeLessThan(SUMMARY_MS);
			expect((await runOf(db, turn.runId!)).ttftMs).not.toBeNull();
			const [thread] = await db.select().from(coachThreads).where(eq(coachThreads.id, threadId));
			expect(thread!.segment).toBe(2);
			// The new segment opens with the summary made ahead, and replays nothing old.
			const sent = JSON.stringify(next.requests[0]!.messages);
			expect(sent).toContain(note!.summary);
			expect(sent).not.toContain(OLD_ANSWER);
			expect(await summaryRuns(db, threadId)).toHaveLength(1);
		});
	});

	it('without work after the turn, the rollover turn’s first words wait for the summary call', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { threadId } = await fillSegment(db, owner, coach(OLD_ANSWER), { after: false });
			const next = coach(NEW_ANSWER);
			const turn = await timedTurn(
				{ db, owner, threadId, tools: [], provider: ready(next), text: 'Where do things stand?' },
				answering(NEW_ANSWER)
			);
			expect(next.structuredCalls()).toBe(1);
			expect(chips(turn.events)).toEqual([DONE_CHIP]);
			expect(turn.firstWordsMs!).toBeGreaterThanOrEqual(SUMMARY_MS);
		});
	});

	it('makes the summary inline when the one made ahead failed', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const old = coach(OLD_ANSWER, { failFirst: true });
			const { threadId, work } = await fillSegment(db, owner, old);
			await work.settled();
			expect(old.structuredCalls()).toBe(1);
			expect(await summaryRuns(db, threadId)).toMatchObject([{ status: 'failed' }]);

			const next = coach(NEW_ANSWER);
			const turn = await timedTurn(
				{ db, owner, threadId, tools: [], provider: ready(next), text: 'Where do things stand?' },
				answering(NEW_ANSWER)
			);
			expect(next.structuredCalls()).toBe(1);
			expect(chips(turn.events)).toEqual([DONE_CHIP]);
			const [note] = await db.select().from(coachNotes).where(eq(coachNotes.ownerId, owner));
			expect(JSON.stringify(next.requests[0]!.messages)).toContain(note!.summary);
		});
	});

	it('a send while the summary ahead is still running waits for it, and is never busy', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			const old = coach(OLD_ANSWER);
			// The real clock: runs are ordered by when they started.
			const now = () => new Date();
			const { threadId, work } = await fillSegment(db, owner, old, { concurrent: true, now });
			// Send once the summary ahead is under way.
			const until = Date.now() + 5_000;
			while ((await summaryRuns(db, threadId)).every((run) => run.status !== 'running')) {
				expect(Date.now(), 'the summary ahead starts').toBeLessThan(until);
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			const next = coach(NEW_ANSWER);
			const turn = await timedTurn(
				{
					db,
					owner,
					threadId,
					now,
					tools: [],
					provider: ready(next),
					text: 'Where do things stand?'
				},
				answering(NEW_ANSWER)
			);
			await work.settled();

			expect(turn.events.filter((event) => event.type === 'error')).toEqual([]);
			expect(turn.events.at(-1)).toEqual({ type: 'done', status: 'completed' });
			expect(old.structuredCalls() + next.structuredCalls()).toBe(1);
			expect(chips(turn.events)).toEqual([DONE_CHIP]);
			const [note] = await db.select().from(coachNotes).where(eq(coachNotes.ownerId, owner));
			expect(JSON.stringify(next.requests[0]!.messages)).toContain(note!.summary);
		});
	});

	it('runs a short, general question that opens a conversation at low effort, the next at medium', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const provider = coach(NEW_ANSWER);
			const first = await timedTurn(
				{ db, owner, tools: [], provider: ready(provider), text: 'What does RPE mean?' },
				answering(NEW_ANSWER)
			);
			expect(provider.requests[0]!.output_config.effort).toBe('low');
			expect(await runOf(db, first.runId!)).toMatchObject({ status: 'completed', effort: 'low' });
			expect(first.firstWordsMs).not.toBeNull();
			expect((await runOf(db, first.runId!)).ttftMs).not.toBeNull();

			const second = await timedTurn(
				{
					db,
					owner,
					threadId: first.threadId,
					tools: [],
					provider: ready(provider),
					text: 'And RIR?'
				},
				answering(NEW_ANSWER)
			);
			expect(provider.requests[1]!.output_config.effort).toBe('medium');
			expect(await runOf(db, second.runId!)).toMatchObject({ effort: 'medium' });

			const planning = await timedTurn(
				{ db, owner, tools: [], provider: ready(provider), text: 'Is my bench on track?' },
				answering(NEW_ANSWER)
			);
			expect(provider.requests[2]!.output_config.effort).toBe('medium');
			expect(await runOf(db, planning.runId!)).toMatchObject({ effort: 'medium' });
		});
	});
});
