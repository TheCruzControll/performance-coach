/**
 * The coach's test support on real Postgres (coach-test-support):
 * - each coach fixture (src/lib/server/test-support/coach-fixtures.ts) stores what it says, at
 *   dates counted from the owner's today in Sydney, quickly, and never on top of coach data. The
 *   seeds run inside the test's transaction, so the setup also proves one query at a time.
 * - POST /api/test-support/coach is a 404 without ENABLE_TEST_ROUTES; with it, each fault and
 *   scripted run changes what POST /api/coach/turns answers, as the e2e specs rely on.
 */
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addDays } from '../../../src/lib/domain/calendar';
import { createSseDecoder, type CoachEvent } from '../../../src/lib/domain/coach/events';
import { clearMockOverrides } from '../../../src/lib/server/agent/provider/faults';
import {
	LONG_ANSWER,
	MANY_BLOCKS,
	SLOW_ANSWER,
	THINKING_PAUSE_MS
} from '../../../src/lib/server/agent/provider/mock-scripts/test';
import type { Executor } from '../../../src/lib/server/db';
import { resetEnvCache } from '../../../src/lib/server/env';
import { listThreads, THREAD_VIEW_MESSAGES } from '../../../src/lib/server/services/coach/threads';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import {
	BUDGET_THREAD_TEXT,
	COACH_FIXTURES,
	CoachSeedConflictError,
	LONG_THREAD_EXCHANGES,
	seedCoachFixture,
	UNPRICED_MODEL,
	type CoachFixture
} from '../../../src/lib/server/test-support/coach-fixtures';
import { POST as postTurn } from '../../../src/routes/api/coach/turns/+server';
import { POST as postSupport } from '../../../src/routes/api/test-support/coach/+server';
import { withCommitted, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';
import { segmentIssues } from './harness';

const TZ = 'Australia/Sydney';
/** A Wednesday in Sydney (daylight saving time). */
const TODAY = '2026-11-18';
const NOW = atLocal(TODAY, '12:00', TZ);

const seed = (db: Executor, owner: string, fixture: CoachFixture) =>
	seedCoachFixture(owner, fixture, { timeZone: TZ, now: NOW }, { db });

async function rows<T>(db: Executor, query: ReturnType<typeof sql>): Promise<T[]> {
	return (await db.execute(query)).rows as T[];
}

const shownOf = (db: Executor, threadId: string) =>
	rows<{ kind: string; text: string | null; display: unknown }>(
		db,
		sql`select kind, content #>> '{}' as text, display from coach_messages
			where thread_id = ${threadId} and kind in ('owner_message', 'assistant') order by seq`
	);

describe('coach fixtures', () => {
	it('bench-month: four weekly bench sessions to yesterday, and an answer citing the bench', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const seeded = await seed(db, owner, 'bench-month');
			expect(seeded).toMatchObject({ today: TODAY, weekStart: '2026-11-16', programId: null });
			const bench = seeded.exercises.bench_press!;
			const sessions = await rows<{ day: string; weights: number[] }>(
				db,
				sql`select to_char((w.started_at at time zone ${TZ})::date, 'YYYY-MM-DD') as day,
						array_agg(s.weight::float order by s.set_index) as weights
					from workouts w join set_records s on s.workout_id = w.id
					where w.owner_id = ${owner} and w.status = 'completed' and s.exercise_id = ${bench}
					group by w.id order by 1`
			);
			expect(sessions).toEqual(
				[80, 82.5, 85, 87.5].map((kg, i) => ({
					day: addDays(TODAY, 7 * (i - 3) - 1),
					weights: [kg, kg, kg]
				}))
			);
			const shown = await shownOf(db, seeded.threads.bench!);
			expect(shown.map((row) => row.kind)).toEqual(['owner_message', 'assistant']);
			const blocks = (shown[1]!.display as { blocks: { kind: string; sources: unknown[] }[] })
				.blocks;
			expect(blocks.flatMap((block) => block.sources)).toContainEqual(
				expect.objectContaining({ type: 'exercise', id: bench, label: 'Bench press' })
			);
			expect(await segmentIssues(db, owner, seeded.threads.bench!)).toEqual([]);
		});
	});

	it('split-squat-week: Bulgarian split squats today and a week on, and no leg press', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const seeded = await seed(db, owner, 'split-squat-week');
			const planned = await rows<{ day: string; key: string }>(
				db,
				sql`select to_char(s.scheduled_on, 'YYYY-MM-DD') as day, e.key
					from programs p
					join program_version_weeks vw on vw.version_id = p.current_version_id
					join planned_sessions s on s.week_id = vw.week_id
					join planned_exercises pe on pe.session_id = s.id
					join exercises e on e.id = pe.exercise_id
					where p.id = ${seeded.programId} and e.key in ('leg_press', 'bulgarian_split_squat')
					order by 1`
			);
			expect(planned).toEqual([
				{ day: TODAY, key: 'bulgarian_split_squat' },
				{ day: addDays(TODAY, 7), key: 'bulgarian_split_squat' }
			]);
			expect(seeded.exercises).toHaveProperty('bulgarian_split_squat');
		});
	});

	it('run-weeks: an easy and a long run in each of the four weeks before this one', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await seed(db, owner, 'run-weeks');
			const runs = await rows<{ day: string; type: string; metres: number }>(
				db,
				sql`select to_char((w.started_at at time zone ${TZ})::date, 'YYYY-MM-DD') as day,
						w.session_type as type, r.distance_m::int as metres
					from workouts w join run_records r on r.workout_id = w.id
					where w.owner_id = ${owner} and w.status = 'completed' order by w.started_at`
			);
			const monday = (week: number) => addDays('2026-11-16', 7 * (week - 5));
			expect(runs).toEqual(
				[1, 2, 3, 4].flatMap((week) => [
					{ day: addDays(monday(week), 1), type: 'easy_run', metres: 6000 },
					{ day: addDays(monday(week), 5), type: 'long_run', metres: 9000 + 1000 * week }
				])
			);
		});
	});

	it('long-thread: more than a page of questions and answers, which a next turn can replay', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const seeded = await seed(db, owner, 'long-thread');
			const shown = await shownOf(db, seeded.threads.long!);
			expect(shown).toHaveLength(2 * LONG_THREAD_EXCHANGES);
			expect(shown.length).toBeGreaterThan(THREAD_VIEW_MESSAGES);
			expect(shown.at(-2)!.text).toBe(
				`Question ${LONG_THREAD_EXCHANGES}: what should I focus on in session ${LONG_THREAD_EXCHANGES}?`
			);
			expect(await segmentIssues(db, owner, seeded.threads.long!)).toEqual([]);
		});
	});

	it('knee-pain: yesterday’s synced leg day with a knee report, and no preference', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const seeded = await seed(db, owner, 'knee-pain');
			const reports = await rows<{ area: string; severity: string; day: string; status: string }>(
				db,
				sql`select p.body_area as area, p.severity, w.status,
						to_char((w.started_at at time zone ${TZ})::date, 'YYYY-MM-DD') as day
					from pain_reports p join workouts w on w.id = p.workout_id
					where p.owner_id = ${owner} and w.client_id = ${seeded.workouts.legDay}`
			);
			expect(reports).toEqual([
				{ area: 'knee', severity: 'moderate', status: 'completed', day: addDays(TODAY, -1) }
			]);
			const [prefs] = await rows<{ n: number }>(
				db,
				sql`select count(*)::int as n from exercise_preferences where owner_id = ${owner}`
			);
			expect(prefs!.n).toBe(0);
		});
	});

	it('archived-threads: three threads, all archived, none in Recent', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const seeded = await seed(db, owner, 'archived-threads');
			expect((await listThreads(owner, {}, { db })).threads).toEqual([]);
			const archived = await listThreads(owner, { archived: true }, { db });
			expect(archived.threads.map((thread) => thread.id).sort()).toEqual(
				Object.values(seeded.threads).sort()
			);
		});
	});

	it('unpriced-run: a run served by a model with no price, counted by the cap', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const seeded = await seed(db, owner, 'unpriced-run');
			const runs = await rows<{ served: string; cost: number | null; cap: number }>(
				db,
				sql`select served_model as served, cost_micros::float as cost, cap_cost_micros::float as cap
					from agent_runs where thread_id = ${seeded.threads.unpriced}`
			);
			expect(runs).toEqual([{ served: UNPRICED_MODEL, cost: null, cap: expect.any(Number) }]);
			expect(runs[0]!.cap).toBeGreaterThan(0);
		});
	});

	// Generous here, as for the analytics fixtures: integration workers share the machine. The
	// browser spec (e2e/coach-support.serial.e2e.ts) holds each seed to a second.
	it.each(COACH_FIXTURES)('seeds %s in under 3 s', async (fixture) => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const started = performance.now();
			await seed(db, owner, fixture);
			expect(performance.now() - started).toBeLessThan(3_000);
		});
	});

	it('refuses a seed on top of coach data, and writes nothing', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await seed(db, owner, 'unpriced-run');
			const count = sql`select count(*)::int as n from coach_messages where owner_id = ${owner}`;
			const [before] = await rows<{ n: number }>(db, count);
			await expect(seed(db, owner, 'archived-threads')).rejects.toBeInstanceOf(
				CoachSeedConflictError
			);
			expect(await rows<{ n: number }>(db, count)).toEqual([before]);
		});
	});
});

// ---- the route --------------------------------------------------------------------------------

const BASE = 'http://localhost:5173';

function event(owner: string, path: string, body: unknown) {
	const request = new Request(`${BASE}${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body)
	});
	return {
		request,
		params: {},
		url: new URL(request.url),
		locals: {
			session: { id: crypto.randomUUID(), ownerId: owner, kind: 'owner' },
			requestId: 'req-test'
		},
		getClientAddress: () => '127.0.0.1'
	} as never;
}

const support = (owner: string, body: unknown) =>
	postSupport(event(owner, '/api/test-support/coach', body));

interface Turn {
	status: number;
	retryAfter: string | null;
	events: CoachEvent[];
	/** Milliseconds from run_started to the first text_delta. */
	silentMs: number | null;
}

async function turn(owner: string, text = 'Hello coach'): Promise<Turn> {
	const response = await postTurn(
		event(owner, '/api/coach/turns', { clientMessageId: crypto.randomUUID(), text })
	);
	const result: Turn = {
		status: response.status,
		retryAfter: response.headers.get('retry-after'),
		events: [],
		silentMs: null
	};
	if (response.status !== 200) return result;
	const decoder = createSseDecoder();
	const reader = response.body!.getReader();
	let startedAt = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		for (const each of decoder.push(value)) {
			if (each.type === 'run_started') startedAt = performance.now();
			if (each.type === 'text_delta') result.silentMs ??= performance.now() - startedAt;
			result.events.push(each);
		}
	}
	return result;
}

const errorOf = (t: Turn) => t.events.find((each) => each.type === 'error');
const doneOf = (t: Turn) => t.events.at(-1);
const textOf = (t: Turn) =>
	t.events.map((each) => (each.type === 'text_delta' ? each.text : '')).join('');
const answered = (t: Turn) => expect(doneOf(t)).toEqual({ type: 'done', status: 'completed' });

describe('POST /api/test-support/coach', () => {
	const before = process.env.ENABLE_TEST_ROUTES;
	const enable = (value: string) => {
		process.env.ENABLE_TEST_ROUTES = value;
		resetEnvCache();
	};
	beforeEach(() => enable('true'));
	afterEach(() => {
		clearMockOverrides();
		if (before === undefined) delete process.env.ENABLE_TEST_ROUTES;
		else process.env.ENABLE_TEST_ROUTES = before;
		resetEnvCache();
	});

	it('is a 404 without ENABLE_TEST_ROUTES, before it reads the request or the session', async () => {
		enable('false');
		const request = new Request(`${BASE}/api/test-support/coach`, {
			method: 'POST',
			body: JSON.stringify({ fault: 'error' })
		});
		await expect(postSupport({ locals: {}, request } as never)).rejects.toMatchObject({
			status: 404
		});
	});

	it('seeds a fixture for the signed-in owner (201), and refuses a second (409)', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			const first = await support(owner, { fixture: 'archived-threads', timeZone: TZ });
			expect(first.status).toBe(201);
			expect(await first.json()).toMatchObject({ fixture: 'archived-threads', timeZone: TZ });
			const second = await support(owner, { fixture: 'archived-threads', timeZone: TZ });
			expect(second.status).toBe(409);
			const bad = await support(owner, { fixture: 'nope', timeZone: TZ });
			expect(bad.status).toBe(400);
		});
	});

	it('refuses an unknown fault, script or delay with 400', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			for (const body of [
				{ fault: 'gremlins' },
				{ script: 'no-such-script' },
				{ chunkDelayMs: -1 },
				{ turnMs: 0 },
				{ turnMs: 1.5 }
			])
				expect((await support(owner, body)).status, JSON.stringify(body)).toBe(400);
		});
	});

	it('each fault changes what the next turn answers, until none', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			const set = async (body: Record<string, unknown>) =>
				expect((await support(owner, body)).status).toBe(200);
			answered(await turn(owner));

			for (const fault of ['error', 'overloaded']) {
				await set({ fault });
				const failed = await turn(owner);
				expect(errorOf(failed), fault).toMatchObject({ kind: 'provider' });
				expect(doneOf(failed), fault).toEqual({ type: 'done', status: 'failed' });
			}

			await set({ fault: 'rate_limited' });
			const limited = await turn(owner);
			expect(limited.status).toBe(429);
			expect(limited.retryAfter).toBe('600');

			await set({ fault: 'unavailable' });
			answered(await turn(owner, "What's on this week?"));
			expect(errorOf(await turn(owner))).toEqual({
				type: 'error',
				kind: 'unavailable',
				reason: 'no_key'
			});

			for (const reason of ['not_launched', 'disabled']) {
				await set({ fault: reason });
				const count = sql`select count(*)::int as n from agent_runs where owner_id = ${owner}`;
				const [runs] = await rows<{ n: number }>(db, count);
				expect((await turn(owner)).events, reason).toEqual([
					{ type: 'error', kind: 'unavailable', reason },
					{ type: 'done', status: null }
				]);
				expect(await rows<{ n: number }>(db, count)).toEqual([runs]);
			}

			await set({ fault: 'refusal' });
			const refused = await turn(owner);
			expect(errorOf(refused)).toMatchObject({ kind: 'refused' });
			expect(doneOf(refused)).toEqual({ type: 'done', status: 'refused' });

			await set({ fault: 'budget' });
			const broke = await turn(owner);
			expect(errorOf(broke)).toMatchObject({ kind: 'budget' });
			expect(doneOf(broke)).toEqual({ type: 'done', status: 'budget_exhausted' });
			// Its spend sits on an archived thread, out of Recent.
			const archived = await listThreads(owner, { archived: true }, { db });
			expect(archived.threads.map((thread) => thread.title)).toEqual([BUDGET_THREAD_TEXT]);
		});
	});

	it('none clears the overrides and the turn limit, but not the day’s spend', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			await support(owner, { fault: 'rate_limited' });
			expect((await turn(owner)).status).toBe(429);
			await support(owner, { fault: 'none' });
			answered(await turn(owner));
			await support(owner, { fault: 'error' });
			await support(owner, { fault: 'none' });
			answered(await turn(owner));
		});
	});

	it('plays a script whatever the owner asks, with a chunk delay or a shorter turn', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			await support(owner, { fault: 'slow', chunkDelayMs: 0 });
			const slow = await turn(owner);
			answered(slow);
			expect(textOf(slow)).toBe(SLOW_ANSWER.replace(/^\[note\] /, ''));

			await support(owner, { fault: 'slow', turnMs: 500 });
			const timedOut = await turn(owner);
			expect(errorOf(timedOut)).toMatchObject({ kind: 'timeout' });
			expect(doneOf(timedOut)).toEqual({ type: 'done', status: 'timed_out' });

			await support(owner, { script: 'thinking-pause' });
			const paused = await turn(owner);
			answered(paused);
			expect(paused.silentMs).toBeGreaterThanOrEqual(THINKING_PAUSE_MS - 50);

			await support(owner, { script: 'long-answer' });
			const long = await turn(owner);
			answered(long);
			const blocks = long.events.filter((each) => each.type === 'block_completed');
			expect(blocks).toHaveLength(LONG_ANSWER.split('\n\n').length);

			await support(owner, { script: 'many-blocks' });
			const many = await turn(owner);
			answered(many);
			expect(many.events.filter((each) => each.type === 'block_completed')).toHaveLength(
				MANY_BLOCKS
			);
		});
	});

	it('exercise-source streams a checked answer citing the exercise its tool returned', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			await support(owner, { script: 'exercise-source' });
			const cited = await turn(owner);
			answered(cited);
			const chips = cited.events.filter((each) => each.type === 'activity');
			expect(chips.map((each) => each.state)).toEqual(['running', 'done']);
			const [bench] = await rows<{ id: string }>(
				db,
				sql`select id::text from exercises where key = 'bench_press'`
			);
			const done = cited.events.filter((each) => each.type === 'block_completed');
			expect(done).toHaveLength(1);
			expect(done[0]).toMatchObject({
				grounded: true,
				sources: [{ type: 'exercise', id: bench!.id, label: 'Bench press' }]
			});
		});
	});
});
