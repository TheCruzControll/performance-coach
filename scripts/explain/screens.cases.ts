/**
 * The main screens' page data in db:explain (page-load.ts), on the analytics owner after M6's
 * cases have run: Today with its streamed plan and week, Train, a session, Coach and one
 * conversation, History and one workout, the start kit endpoint and a full sync batch. Each is
 * timed as the M6 loads are (WARM_UPS untimed runs, then the median and p95 of TIMED_RUNS,
 * serialisation included) and gated the same way: a median over PAGE_LIMIT_MS or page data over
 * PAGE_DATA_LIMIT_BYTES gzip fails the run.
 * - Every load runs on its own pool of POOL_MAX connections (db/client.ts createPool), as the app
 *   does, so a load that reads on several connections at once is timed as it runs.
 * - The owner first completes onboarding (two goals and a schedule with a commitment), as Today
 *   reads it once a program exists; the active program covers today.
 * - A load that fails soft (a designed error state) fails the run instead of timing the error.
 * - Each timed load reports its statements per run (round trips to Postgres). Today is also timed
 *   on a pool that waits SIMULATED_RTT_MS before every statement, a same-region round trip to Neon
 *   (docs/deployment.md: pdx1 next to aws-us-west-2), which localhost does not have: reported, not
 *   gated, as it is an estimate of production, not a measurement of it.
 * - The JSON endpoints are serialised with devalue like the pages, which is within a few bytes of
 *   their JSON.
 * - The sync batch is a new workout each run: its start and 24 sets over six exercises, the most a
 *   flush sends (SYNC_LIMITS.maxMutations), with the canonical rows it answers. It runs last.
 */
import { execSync } from 'node:child_process';
import os from 'node:os';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, type IsoDate } from '../../src/lib/domain/calendar';
import { createMutation, SYNC_LIMITS } from '../../src/lib/domain/workout/index';
import { createDatabase, createPool } from '../../src/lib/server/db/client';
import type { Database } from '../../src/lib/server/db/types';
import {
	completeOnboarding,
	createGoal,
	saveSchedule
} from '../../src/lib/server/services/profile/index';
import { getTodayPlan } from '../../src/lib/server/services/programs/index';
import { kitForLineage } from '../../src/lib/server/services/workouts/kit';
import { applySyncBatch } from '../../src/lib/server/services/workouts/sync';
import { loadCoachScreen } from '../../src/routes/(app)/coach/[[thread]]/coach.server';
import { loadWorkoutHistory } from '../../src/routes/(app)/progress/workouts/[[id]]/history.server';
import { loadToday } from '../../src/routes/(app)/today/load.server';
import { loadSessionDetail } from '../../src/routes/(app)/train/session/[key]/detail.server';
import { loadTrainWeek } from '../../src/routes/(app)/train/week.server';
import { FIRST_MONDAY, WEEKS } from './dataset';
import {
	kb,
	loadProblems,
	PAGE_LIMIT_MS,
	PAGE_TARGET_MS,
	TIMED_RUNS,
	timeLoad,
	WARM_UPS,
	type LoadTiming
} from './page-load';

/** The app's pool size (env.ts DB_POOL_MAX's default). */
export const POOL_MAX = 5;
/** A same-region round trip to Neon, added before each statement of the simulated pool. */
export const SIMULATED_RTT_MS = 2;

/** The Wednesday of the dataset's last week, as the M3 and M6 cases read it, and noon on it. */
const TODAY = addDays(FIRST_MONDAY, (WEEKS - 1) * 7 + 2) as IsoDate;
const NOW = new Date(`${TODAY}T12:00:00Z`);
const SET_EXERCISES = [
	'back_squat',
	'romanian_deadlift',
	'bulgarian_split_squat',
	'lying_leg_curl',
	'leg_extension',
	'standing_calf_raise'
] as const;

interface Pooled {
	pool: pg.Pool;
	db: Database;
	/** Statements sent since the pool was made. */
	statements: () => number;
	/** The mean wait each statement really had before it left (timers overshoot), in ms. */
	meanWait: () => number;
}

/** A pool like the app's that counts its statements, and waits `rttMs` before each one. */
function pooled(url: string, rttMs = 0): Pooled {
	const pool = createPool(url, { max: POOL_MAX });
	let sent = 0;
	let waited = 0;
	const wait = async () => {
		const from = performance.now();
		await new Promise((resolve) => setTimeout(resolve, rttMs));
		waited += performance.now() - from;
	};
	pool.on('connect', (client) => {
		const query = client.query.bind(client) as (...args: unknown[]) => unknown;
		(client as { query: unknown }).query = (...args: unknown[]) => {
			sent++;
			if (rttMs === 0) return query(...args);
			// pg calls back or resolves: either way the statement leaves after the round trip.
			return wait().then(() => query(...args));
		};
	});
	return {
		pool,
		db: createDatabase(pool),
		statements: () => sent,
		meanWait: () => (sent ? waited / sent : 0)
	};
}

const origin = (path: string) => ({
	requestId: 'db-explain',
	method: 'GET',
	path,
	routeId: null,
	appVersion: 'explain'
});

/** The machine, day and commit a timing was taken on (as analytics.cases.ts writes it). */
function machine(): string {
	const commit = (process.env.GITHUB_SHA ?? execSync('git rev-parse HEAD').toString()).slice(0, 7);
	const cpu = `${os.cpus()[0]?.model ?? 'cpu'} × ${os.cpus().length}`;
	return `${new Date().toISOString().slice(0, 10)} · commit ${commit} · ${cpu} · ${os.platform()}`;
}

/** Fails the timing when a load answered with its designed error instead of its data. */
function ready<T>(name: string, value: T, ok: (value: T) => boolean): T {
	if (!ok(value)) throw new Error(`${name} answered with its error state`);
	return value;
}

/** A load by name, and whether it runs on the simulated round trip (reported, not gated). */
type Load = [name: string, load: (db: Database) => Promise<unknown>, simulated: boolean];

export function screensExplain({ url, owner }: { url: string; owner: string }) {
	const app = pooled(url);
	const far = pooled(url, SIMULATED_RTT_MS);
	const loaded = { lineage: '', thread: '', workout: '', exercises: [] as string[] };
	const timings: string[] = [];
	const coachTimings: string[] = [];
	let machineLine = '';

	const today = async (db: Database) => {
		const data = await loadToday(owner, { now: NOW, origin: origin('/today') }, { db });
		const plan = await data.plan;
		const week = await data.week;
		ready('/today', data, (d) => d.setup?.complete === true && d.program === 'active');
		ready('/today plan', plan, (p) => p?.failed === false && p.week !== null);
		ready('/today week', week, (w) => w?.failed === false);
		return { ...data, plan, week };
	};

	/** A new workout's start and its sets, as one flush sends them. */
	const batch = () => {
		const workoutId = crypto.randomUUID();
		const started = Date.now();
		const at = (minute: number) => new Date(started + minute * 60_000).toISOString();
		const start = createMutation('workout.start', {
			workoutId,
			at: at(0),
			payload: {
				kind: 'strength',
				title: 'Lower body',
				sessionType: 'strength',
				discipline: 'strength',
				plannedSessionId: null,
				plannedLineage: null,
				programId: null
			}
		});
		const perExercise = (SYNC_LIMITS.maxMutations - 1) / loaded.exercises.length;
		const sets = loaded.exercises.flatMap((exerciseId, i) =>
			Array.from({ length: perExercise }, (_, s) =>
				createMutation('set.log', {
					workoutId,
					at: at(1 + i * perExercise + s),
					payload: {
						position: i + 1,
						plannedLineage: null,
						setIndex: s + 1,
						exerciseId,
						reps: 5,
						seconds: null,
						metres: null,
						weight: 100 + s * 2.5,
						assistance: null,
						unit: 'kg',
						rpe: 8,
						missedReps: 0,
						isWarmup: false,
						isExtra: false
					}
				})
			)
		);
		// As the endpoint receives them: parsed from JSON.
		return JSON.parse(JSON.stringify([start, ...sets])) as Record<string, unknown>[];
	};

	const COACH_LOADS: Load[] = [
		[
			'/coach',
			async (db) =>
				ready(
					'/coach',
					await loadCoachScreen(
						owner,
						{ thread: undefined, search: new URLSearchParams(), origin: origin('/coach') },
						{ db, now: () => NOW }
					),
					(d) => !d.failed && d.threads.length > 0
				),
			false
		],
		[
			'/coach/[thread], the longest conversation',
			async (db) =>
				ready(
					'/coach/[thread]',
					await loadCoachScreen(
						owner,
						{
							thread: loaded.thread,
							search: new URLSearchParams(),
							origin: origin(`/coach/${loaded.thread}`)
						},
						{ db, now: () => NOW }
					),
					(d) => !d.failed && d.thread !== null
				),
			false
		]
	];

	const LOADS: Load[] = [
		['/today, with its streamed plan', today, false],
		[
			`/today, with its streamed plan, at a simulated ${SIMULATED_RTT_MS} ms round trip`,
			today,
			true
		],
		[
			'/train',
			async (db) =>
				ready(
					'/train',
					await loadTrainWeek(owner, { now: NOW, week: null, origin: origin('/train') }, { db }),
					(d) => d.state === 'program'
				),
			false
		],
		[
			"/train/session/[key], today's strength session, with its swaps",
			async (db) => {
				const path = `/train/session/${loaded.lineage}`;
				const data = await loadSessionDetail(
					owner,
					{ key: loaded.lineage, version: null, now: NOW, origin: origin(path) },
					{ db }
				);
				if (data.state !== 'session') throw new Error(`${path} answered with its error state`);
				return { ...data, swaps: ready(path, await data.swaps, (s) => s !== null) };
			},
			false
		],
		[
			'/progress/workouts (History)',
			async (db) =>
				ready(
					'/progress/workouts',
					await loadWorkoutHistory(
						owner,
						{ id: undefined, before: null, origin: origin('/progress/workouts') },
						{ db }
					),
					(d) => d.state === 'ready' && d.rows.length > 0
				),
			false
		],
		[
			'/progress/workouts/[id], the latest strength workout',
			async (db) =>
				ready(
					'/progress/workouts/[id]',
					await loadWorkoutHistory(
						owner,
						{ id: loaded.workout, before: null, origin: origin('/progress/workouts/[id]') },
						{ db }
					),
					(d) => d.state === 'ready' && d.detail !== null
				),
			false
		],
		[
			"GET /api/workouts/kit, today's strength session",
			async (db) =>
				ready('kit', await kitForLineage(owner, loaded.lineage, { db }), (kit) => kit !== null),
			false
		],
		[
			`POST /api/workouts/sync, a new workout's start and ${SYNC_LIMITS.maxMutations - 1} sets`,
			async (db) =>
				ready('sync', await applySyncBatch(owner, batch(), { db, requestId: 'db-explain' }), (r) =>
					r.results.every((result) => result.status === 'applied')
				),
			false
		]
	];

	/** The onboarding Today reads, and what the loads name: today's session, the latest workout. */
	async function prepareMain() {
		const { db } = app;
		await createGoal(
			owner,
			{
				kind: 'event',
				title: 'Half marathon',
				disciplines: ['running'],
				eventType: 'Half marathon',
				eventDate: addDays(TODAY, 120)
			},
			{ db }
		);
		await createGoal(
			owner,
			{
				kind: 'general',
				title: 'Keep my strength',
				disciplines: ['strength'],
				focus: 'Hold squat and deadlift',
				measure: 'Top sets at RPE 8 stay within 5%'
			},
			{ db }
		);
		await saveSchedule(
			owner,
			{
				daysPerWeek: 6,
				availableDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'],
				preferredTimes: ['morning'],
				sessionMinutes: 70,
				constraints: null,
				commitments: [
					{
						discipline: 'muay_thai',
						label: 'Muay Thai class',
						days: ['wed'],
						timeOfDay: 'evening',
						durationMinutes: 90,
						intensity: 'hard'
					}
				]
			},
			{ db }
		);
		await completeOnboarding(owner, { db });
		const plan = await getTodayPlan(owner, TODAY, { db });
		const strength = plan?.sessions.find((s) => s.kind === 'strength');
		if (!strength) throw new Error(`no strength session is planned on ${TODAY}`);
		loaded.lineage = strength.lineage;
		const latest = await app.pool.query<{ id: string }>(
			`select client_id as id from workouts where owner_id = $1 and status = 'completed'
			 and kind = 'strength' and deleted_at is null order by started_at desc, id desc limit 1`,
			[owner]
		);
		loaded.workout = latest.rows[0]!.id;
		const named = await app.pool.query<{ id: string; key: string }>(
			'select id, key from exercises where key = any($1)',
			[SET_EXERCISES]
		);
		loaded.exercises = SET_EXERCISES.map((key) => named.rows.find((row) => row.key === key)!.id);
	}

	/** The conversation with the most messages. */
	async function prepareCoach() {
		const threads = await app.pool.query<{ id: string }>(
			`select thread_id as id from coach_messages where owner_id = $1
			 group by thread_id order by count(*) desc, thread_id limit 1`,
			[owner]
		);
		loaded.thread = threads.rows[0]!.id;
	}

	/** Registers a describe that prepares, then times each of `loads` into `rows`. */
	function timed(title: string, prepare: () => Promise<void>, loads: Load[], rows: string[]) {
		describe(title, () => {
			beforeAll(async () => {
				await prepare();
				machineLine = machine();
			}, 120_000);

			it.each(loads)(
				`times %s: ${WARM_UPS} warm-ups, then the median and p95 of ${TIMED_RUNS} runs`,
				async (name, load, simulated) => {
					const on = simulated ? far : app;
					const before = on.statements();
					const timing: LoadTiming = await timeLoad(() => load(on.db));
					const statements = Math.round((on.statements() - before) / (WARM_UPS + TIMED_RUNS));
					const problems = loadProblems(timing);
					const verdict = timing.median <= PAGE_TARGET_MS ? 'within' : 'over';
					const gate = simulated ? 'reported' : problems.length ? problems.join('; ') : 'pass';
					rows.push(
						`| ${name} | ${timing.median.toFixed(1)} ms | ${timing.p95.toFixed(1)} ms | ${verdict} ${PAGE_TARGET_MS} ms | ${statements} | ${kb(timing.size.gzip)} (${kb(timing.size.raw)}) | ${gate} |`
					);
					console.log(
						`\n${name} (${machineLine})\nmedian ${timing.median.toFixed(1)} ms, p95 ${timing.p95.toFixed(1)} ms, ${statements} statements, page data ${kb(timing.size.gzip)} gzip (${kb(timing.size.raw)})`
					);
					expect(simulated ? [] : problems, name).toEqual([]);
				},
				120_000
			);
		});
	}

	return {
		/**
		 * Coach, on the history owner's coach dataset: registered before M6, whose loader replaces
		 * the training rows and, by cascade, the coach rows that name them.
		 */
		coach: () =>
			timed('coach screens on the history owner', prepareCoach, COACH_LOADS, coachTimings),
		/** Every other screen, on the analytics owner once M6 has run; then the pools close. */
		main: () => {
			timed('main screens on the analytics owner', prepareMain, LOADS, timings);
			afterAll(async () => {
				await app.pool.end();
				await far.pool.end();
			});
		},
		/** The main screens' section of test-results/explain.md; empty when they never ran. */
		report: (): string[] =>
			timings.length || coachTimings.length
				? [
						'## Main screens',
						'',
						`The analytics owner, onboarded (Coach: the history owner, with the coach dataset), today ${TODAY}, on a pool of ${POOL_MAX} (${machineLine}): ${WARM_UPS} warm-ups, then the median and p95 of ${TIMED_RUNS} runs, serialisation included. A median over ${PAGE_LIMIT_MS} ms fails; the simulated round trip is reported only (each statement waited a mean of ${far.meanWait().toFixed(1)} ms).`,
						'',
						'| Load | Median | p95 | Target | Statements | Page data gzip (raw) | Gate |',
						'| --- | ---: | ---: | --- | ---: | ---: | --- |',
						...timings,
						...coachTimings,
						''
					]
				: []
	};
}
