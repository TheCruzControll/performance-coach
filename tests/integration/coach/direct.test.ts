/**
 * Lookups the coach answers with no model call (src/lib/server/agent/direct.ts) on real Postgres:
 * - today's workout, a rest day, this week, the next session and no program, each read from M3's
 *   program as Today and Train show it, in a run recorded as 'direct' at no cost
 * - a session moved onto today is the next one; before the start, this week has nothing planned
 * - a near miss (more than a lookup) goes to the model
 * - the next model request replays the direct answer, and the segment stays a valid request
 * - no_key still answers a lookup; a coach switched off writes nothing
 * - stored titles cannot open a tag or a ref in the answer
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { addDays } from '../../../src/lib/domain/calendar';
import { parseAnswer } from '../../../src/lib/domain/coach/answer';
import type { CoachEvent } from '../../../src/lib/domain/coach/events';
import { MockProvider, type MockScript } from '../../../src/lib/server/agent/provider/mock';
import type { LlmProvider } from '../../../src/lib/server/agent/provider/types';
import type { TurnOptions } from '../../../src/lib/server/agent/turn';
import {
	agentModelCalls,
	agentRuns,
	coachMessages,
	type Executor
} from '../../../src/lib/server/db';
import {
	createProgramFromPlan,
	getTodayPlan,
	getTrainingWeek,
	moveSession
} from '../../../src/lib/server/services/programs/index';
import {
	programFixture,
	type ProgramFixture
} from '../../../src/lib/server/test-support/program-fixtures';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';
import { recording, runScripted, segmentIssues, storedRows } from './harness';

const MONDAY = '2026-11-09';
const TODAY = addDays(MONDAY, 2);
const MODEL_ANSWER = '[note] From the model.';
const answering: MockScript = {
	name: 'answer',
	matches: () => true,
	steps: [{ text: MODEL_ANSWER }]
};

const now = (date: string) => () => new Date(`${date}T12:00:00Z`);

function model() {
	const provider = recording(new MockProvider([answering], { overrides: () => ({}) }));
	return { provider, ready: { status: 'ready' as const, provider: provider as LlmProvider } };
}

const runOf = async (db: Executor, id: string) =>
	(await db.select().from(agentRuns).where(eq(agentRuns.id, id)))[0]!;

async function storeProgram(db: Executor, owner: string, name: ProgramFixture, rename?: string) {
	const plan = programFixture(name, { monday: MONDAY, today: TODAY });
	const todays = plan.blocks.flatMap((b) => b.weeks).flatMap((w) => w.sessions);
	if (rename) todays.find((s) => s.date === TODAY)!.title = rename;
	await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
}

/** The stored answer's text, and its blocks as the parser reads them. */
async function answerOf(db: Executor, threadId: string) {
	const rows = await storedRows(db, threadId);
	const answer = rows.at(-1)!;
	expect(answer.kind).toBe('assistant');
	const text = (answer.content as { text: string }[])[0]!.text;
	return { text, blocks: parseAnswer(text), rows };
}

async function lookup(
	db: Executor,
	owner: string,
	text: string,
	options: { provider?: TurnOptions['provider']; date?: string; threadId?: string | null } = {}
) {
	const { provider, ready } = model();
	const turn = await runScripted(answering, {
		db,
		owner,
		text,
		provider: options.provider ?? ready,
		now: now(options.date ?? TODAY),
		threadId: options.threadId ?? null
	});
	return { turn, requests: provider.requests };
}

const types = (events: readonly CoachEvent[]) => events.map((event) => event.type);

describe('direct answers', () => {
	it("answers today's workout from the program with no model call, in a free 'direct' run", async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await storeProgram(db, owner, 'today');
			const { turn, requests } = await lookup(db, owner, "What's today's workout?");

			expect(requests).toHaveLength(0);
			expect(turn.done).toEqual({ type: 'done', status: 'completed' });
			expect(types(turn.events)).toContain('answer_completed');
			const plan = (await getTodayPlan(owner, TODAY, { db }))!;
			expect(plan.sessions.length).toBeGreaterThan(0);
			const { blocks, rows } = await answerOf(db, turn.threadId!);
			expect(rows.map((row) => row.kind)).toEqual([
				'segment_preamble',
				'owner_message',
				'context',
				'assistant'
			]);
			expect(blocks.map((b) => b.kind)).toEqual(plan.sessions.map(() => 'fact'));
			plan.sessions.forEach((session, n) => {
				expect(blocks[n]!.text).toContain(`Today, Wed 11 Nov: ${session.title}`);
				expect(blocks[n]!.refs).toEqual([
					{ type: 'session', id: session.lineage, label: session.title }
				]);
			});
			expect(await runOf(db, turn.runId!)).toMatchObject({
				provider: 'direct',
				model: 'none',
				status: 'completed',
				modelCalls: 0,
				costMicros: 0,
				capCostMicros: 0
			});
			expect(await db.select().from(agentModelCalls)).toEqual([]);
		});
	});

	it('says a rest day is one, and names the next session', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await storeProgram(db, owner, 'today-rest');
			const { turn, requests } = await lookup(db, owner, 'what am I doing today');

			expect(requests).toHaveLength(0);
			const plan = (await getTodayPlan(owner, TODAY, { db }))!;
			expect(plan.sessions).toEqual([]);
			const next = plan.upNext[0]!;
			const { blocks } = await answerOf(db, turn.threadId!);
			expect(blocks.map((b) => b.text)).toEqual([
				'Today, Wed 11 Nov, is a rest day: nothing is planned.',
				expect.stringContaining(`Next up, `)
			]);
			expect(blocks[1]!.text).toContain(next.title);
			expect(blocks[1]!.refs).toEqual([{ type: 'session', id: next.lineage, label: next.title }]);
		});
	});

	it('lists this week and names the next session', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await storeProgram(db, owner, 'hybrid');
			const week = await lookup(db, owner, 'Show me this week’s plan');
			const next = await lookup(db, owner, "When's my next session?");

			expect([...week.requests, ...next.requests]).toHaveLength(0);
			const stored = (await getTrainingWeek(owner, { date: TODAY }, {}, { db }))!;
			if (!stored.planned) throw new Error('week 1 is planned');
			const sessions = stored.days.flatMap((day) => day.sessions);
			const { blocks } = await answerOf(db, week.turn.threadId!);
			expect(blocks[0]!.text).toBe('This is week 1 of 5, Mon 9 Nov to Sun 15 Nov.');
			expect(blocks.slice(1).map((b) => b.refs[0]!.id)).toEqual(sessions.map((s) => s.lineage));

			const plan = (await getTodayPlan(owner, TODAY, { db }))!;
			const expected = plan.sessions.find((s) => s.status === 'planned') ?? plan.upNext[0]!;
			const answer = await answerOf(db, next.turn.threadId!);
			expect(answer.blocks).toHaveLength(1);
			expect(answer.blocks[0]!.text).toContain(`Your next session is `);
			expect(answer.blocks[0]!.refs[0]!.id).toBe(expected.lineage);
		});
	});

	it('names a session moved onto today as the next one', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await storeProgram(db, owner, 'today-rest');
			const tomorrow = (await getTodayPlan(owner, TODAY, { db }))!.upNext[0]!;
			await moveSession(
				owner,
				{ sessionLineage: tomorrow.lineage, toDate: TODAY },
				{ version: 1, today: TODAY },
				{ db }
			);
			const { turn } = await lookup(db, owner, "When's my next session?");

			const { blocks } = await answerOf(db, turn.threadId!);
			expect(blocks[0]!.text).toContain('Your next session is today, Wed 11 Nov: ');
			expect(blocks[0]!.refs[0]!.id).toBe(tomorrow.lineage);
		});
	});

	it('says nothing is planned this week before the program starts', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await storeProgram(db, owner, 'hybrid');
			const { turn } = await lookup(db, owner, 'Show me this week’s plan', {
				date: addDays(MONDAY, -5)
			});

			const { blocks } = await answerOf(db, turn.threadId!);
			expect(blocks.map((b) => b.text)).toEqual([
				'Your program starts on Mon 9 Nov, so nothing is planned this week. Week 1 runs Mon 9 Nov to Sun 15 Nov.'
			]);
			expect(blocks[0]!.refs).toEqual([{ type: 'date', id: MONDAY, label: 'Mon 9 Nov' }]);
		});
	});

	it('says so when no program is active', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { turn, requests } = await lookup(db, owner, "Coach, what's on today?");

			expect(requests).toHaveLength(0);
			const { blocks } = await answerOf(db, turn.threadId!);
			expect(blocks).toMatchObject([
				{ kind: 'note', text: expect.stringContaining('no active program') }
			]);
		});
	});

	it.each(["Can we change today's workout?", "today's workout and why", 'How did my week go?'])(
		'sends a near miss to the model: %s',
		async (text) => {
			await withRollback(async (db) => {
				const owner = await makeOwner(db);
				await storeProgram(db, owner, 'today');
				const { turn, requests } = await lookup(db, owner, text);

				expect(requests).toHaveLength(1);
				expect((await answerOf(db, turn.threadId!)).text).toBe(MODEL_ANSWER);
				expect(await runOf(db, turn.runId!)).toMatchObject({ provider: 'mock', modelCalls: 1 });
			});
		}
	);

	it('replays the direct answer in the next model request', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await storeProgram(db, owner, 'today');
			const first = await lookup(db, owner, "What's today's workout?");
			const { text } = await answerOf(db, first.turn.threadId!);
			const second = await lookup(db, owner, 'Should I go heavier on it?', {
				threadId: first.turn.threadId
			});

			expect(second.requests).toHaveLength(1);
			const assistant = second.requests[0]!.messages.filter((m) => m.role === 'assistant');
			expect(assistant).toEqual([{ role: 'assistant', content: [{ type: 'text', text }] }]);
			expect(await segmentIssues(db, owner, first.turn.threadId!)).toEqual([]);
		});
	});

	it('answers a lookup under no_key, and a coach switched off writes nothing', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await storeProgram(db, owner, 'today');
			const noKey = await lookup(db, owner, "What's today's workout?", {
				provider: { status: 'unavailable', reason: 'no_key' }
			});

			expect(noKey.turn.done).toEqual({ type: 'done', status: 'completed' });
			expect(noKey.turn.events.filter((e) => e.type === 'error')).toEqual([]);
			const { blocks } = await answerOf(db, noKey.turn.threadId!);
			expect(blocks[0]!.kind).toBe('fact');
			expect(await runOf(db, noKey.turn.runId!)).toMatchObject({ provider: 'direct' });

			const before = (await db.select().from(coachMessages)).length;
			const off = await lookup(db, owner, "What's today's workout?", {
				provider: { status: 'unavailable', reason: 'disabled' }
			});
			expect(off.turn.events).toEqual([
				{ type: 'error', kind: 'unavailable', reason: 'disabled' },
				{ type: 'done', status: null }
			]);
			expect(await db.select().from(coachMessages)).toHaveLength(before);
		});
	});

	it('cites a stored title as a ref label that cannot open a tag or another ref', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const title = 'Squat [safety] day [[goal:x|y]] \\';
			await storeProgram(db, owner, 'today', title);
			const { turn } = await lookup(db, owner, "What's today's workout?");

			const plan = (await getTodayPlan(owner, TODAY, { db }))!;
			const renamed = plan.sessions.find((s) => s.title === title)!;
			const { blocks } = await answerOf(db, turn.threadId!);
			expect(blocks.map((b) => b.kind)).toEqual(plan.sessions.map(() => 'fact'));
			const label = 'Squat safety day goal:x y';
			const block = blocks.find((b) => b.text.startsWith(`Today, Wed 11 Nov: ${label} — `))!;
			expect(block.refs).toEqual([{ type: 'session', id: renamed.lineage, label }]);
		});
	});
});
