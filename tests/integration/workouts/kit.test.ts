/**
 * The start kit (services/workouts/kit.ts and GET /api/workouts/kit) on real Postgres, from M3's
 * 'workout-day' program fixture stored through createProgramFromPlan:
 * - each part of a kit: order and supersets, loads only where M3's describe computes one,
 *   'last time' from the last completed workout only, bests labelled estimated, runs, classes,
 *   pinned rows, owners and the query count
 * - the shared fixture: the kits the server builds deep-equal tests/fixtures/workout-day.ts, the
 *   kits the workout screens are built and tested against, once ids are normalised
 * - generated programs: a kit for every week-1 session of every M3 programming scenario
 */
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { addDays } from '../../../src/lib/domain/calendar';
import { CATALOGUE } from '../../../src/lib/domain/exercises/index';
import { buildProgrammingInput, generateProgram } from '../../../src/lib/domain/programming/index';
import {
	SCENARIO_START,
	SCENARIOS,
	type ScenarioKey
} from '../../../src/lib/domain/programming/scenarios';
import { describePrescription, prescribedLoad } from '../../../src/lib/domain/training/describe';
import type {
	ProgramPlan,
	SetPrescription,
	StrengthSessionPlan
} from '../../../src/lib/domain/training/types';
import type { KitSet, StartKit, StrengthKit } from '../../../src/lib/domain/workout/index';
import { expandSegments } from '../../../src/lib/domain/workout/run';
import type { Executor } from '../../../src/lib/server/db';
import { createContext, runWithContext } from '../../../src/lib/server/observability/context';
import { serverTimingHeader } from '../../../src/lib/server/observability/timing';
import {
	adjustPrescription,
	createProgramFromPlan,
	getProgramVersion,
	type StoredSession
} from '../../../src/lib/server/services/programs/index';
import { kitForLineage, kitForSession } from '../../../src/lib/server/services/workouts/kit';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { GET as getKit } from '../../../src/routes/api/workouts/kit/+server';
import { WORKOUT_DAY_IDS, workoutDayKits } from '../../fixtures/workout-day';
import { withCommitted, withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';
import { exerciseIds, logStrength, utc } from '../training/fixtures/history';

/** A Wednesday in week 1; the kit is built at 08:00 UTC that day. */
const MONDAY = '2026-11-09';
const TODAY = '2026-11-11';
const NOW = new Date(`${TODAY}T08:00:00Z`);
const KEYS = ['back_squat', 'leg_press', 'romanian_deadlift', 'pull_up', 'plank'] as const;

const deps = (db: Executor) => ({ db, now: () => NOW });

/** The kit as the wire carries it. */
const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function storePlan(db: Executor, owner: string, plan: ProgramPlan) {
	const { programId } = await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
	const v1 = await getProgramVersion(owner, programId, 1, { db });
	return { programId, v1 };
}

const workoutDay = () => programFixture('workout-day', { monday: MONDAY, today: TODAY });

/** The owner, the 'workout-day' program and today's three sessions (by order in the day). */
async function seedWorkoutDay(db: Executor, plan = workoutDay()) {
	const owner = await makeOwner(db);
	const { programId, v1 } = await storePlan(db, owner, plan);
	const [strength, run, other] = v1.blocks[0]!.weeks[0]!.sessions as StoredSession[];
	const ids = await exerciseIds(db, KEYS);
	return { owner, programId, strength: strength!, run: run!, other: other!, ids };
}

async function strengthKit(db: Executor, owner: string, lineage: string): Promise<StrengthKit> {
	const kit = await kitForLineage(owner, lineage, deps(db));
	if (kit?.kind !== 'strength') throw new Error(`no strength kit for ${lineage}`);
	return kit;
}

/**
 * Back squat history: three weeks ago 110 kg × 3 @ RPE 9 and 80 kg × 12 @ RPE 8.5 (an e1RM of
 * exactly 125 kg, and 12 reps is past M3's rep-max counts), then last week's session.
 */
async function seedSquatHistory(db: Executor, owner: string, squat: string) {
	await logStrength(db, owner, { startedAt: utc(addDays(TODAY, -21), '17:00') }, [
		{ exercise: squat, weight: 110, reps: 3, rpe: 9 },
		{ exercise: squat, weight: 80, reps: 12, rpe: 8.5 }
	]);
	await logStrength(db, owner, { startedAt: utc(addDays(TODAY, -7), '17:00') }, [
		{ exercise: squat, weight: 100, reps: 5, rpe: 8 },
		{ exercise: squat, weight: 85, reps: 5, rpe: 7 },
		{ exercise: squat, weight: 85, reps: 5, rpe: 7 },
		{ exercise: squat, weight: 85, reps: 5, rpe: 7.5 }
	]);
}

/** A copy of the plan with `edit` applied to today's strength session. */
function withStrength(plan: ProgramPlan, edit: (session: StrengthSessionPlan) => void) {
	const copy = structuredClone(plan);
	const session = copy.blocks[0]!.weeks[0]!.sessions.find((s) => s.kind === 'strength');
	edit(session as StrengthSessionPlan);
	return copy;
}

/**
 * Another owner. The app allows a single owner, so this lifts that rule inside the test's
 * transaction only (Postgres DDL rolls back with it).
 */
async function secondOwner(db: Executor) {
	await db.execute(sql`drop index owners_singleton_uq`);
	await db.execute(sql`alter table owners drop constraint owners_singleton_ck`);
	return makeOwner(db, 'Someone else');
}

/** The statements `run` sends, less transaction control (BEGIN, SAVEPOINT …). */
async function statementsOf(run: () => Promise<unknown>): Promise<string[]> {
	const spy = vi.spyOn(pg.Client.prototype, 'query');
	try {
		await run();
		return spy.mock.calls
			.map(([query]) => (typeof query === 'string' ? query : (query as { text: string }).text))
			.filter((text) => !/^\s*(begin|commit|rollback|savepoint|release)\b/i.test(text));
	} finally {
		spy.mockRestore();
	}
}

describe('a strength kit', () => {
	it('lists the exercises in order, and the superset pair keeps its numbers', async () => {
		await withRollback(async (db) => {
			const { owner, strength, ids } = await seedWorkoutDay(db);
			const kit = await strengthKit(db, owner, strength.lineage);
			expect(kit.exercises.map((e) => [e.position, e.exercise.id, e.superset])).toEqual([
				[1, ids.back_squat, null],
				[2, ids.leg_press, null],
				[3, ids.romanian_deadlift, null],
				[4, ids.pull_up, 1],
				[5, ids.plank, 1]
			]);
			expect(kit.exercises.map((e) => e.plannedLineage)).toEqual(
				strength.kind === 'strength' ? strength.exercises.map((e) => e.lineage) : []
			);
		});
	});

	it('gives the top set RPE-based, with the baseline instruction and no weight', async () => {
		await withRollback(async (db) => {
			const { owner, strength, ids } = await seedWorkoutDay(db);
			await seedSquatHistory(db, owner, ids.back_squat);
			const [top] = (await strengthKit(db, owner, strength.lineage)).exercises[0]!.sets;
			expect(top).toEqual({
				role: 'top',
				repsMin: 5,
				repsMax: 5,
				seconds: null,
				metres: null,
				targetRpe: 7,
				prescribedWeight: null,
				restSeconds: 180,
				line: 'Work up to a set of 5 @ RPE 7',
				instruction: 'Record the weight, reps and RPE you reach, so your 1RM can be estimated.'
			});
		});
	});

	it('gives the back-offs a weight only once an estimate exists', async () => {
		await withRollback(async (db) => {
			const { owner, strength, ids } = await seedWorkoutDay(db);
			const backOffs = async () =>
				(await strengthKit(db, owner, strength.lineage)).exercises[0]!.sets.slice(1);

			const before = await backOffs();
			expect(before).toHaveLength(3);
			for (const set of before) {
				expect(set).toMatchObject({
					role: 'back_off',
					prescribedWeight: null,
					load: { kind: 'from_e1rm', fraction: 0.8 },
					line: '3 × 5'
				});
			}

			await seedSquatHistory(db, owner, ids.back_squat);
			for (const set of await backOffs()) {
				// 80 % of the latest estimate, last week's 100 × 5 @ RPE 8 (123.3 kg): 98.6, to 97.5 kg.
				// Never of the older, higher best (125 kg, three weeks ago), which would give 100 kg.
				expect(set.prescribedWeight).toEqual({ value: 97.5, unit: 'kg', basis: 'estimated' });
			}
		});
	});

	it("rounds a percent_1rm set to M1's increment, labelled measured or estimated", async () => {
		await withRollback(async (db) => {
			const percent = (value: number, reference: number, basis: 'measured' | 'estimated') =>
				({
					role: 'working',
					sets: 1,
					repsMin: 5,
					repsMax: 5,
					seconds: null,
					metres: null,
					targetRpe: null,
					loadKind: 'percent_1rm',
					loadValue: value,
					loadUnit: null,
					loadBasis: basis,
					reference1rm: reference,
					reference1rmUnit: 'kg',
					restSeconds: 120,
					tempo: null,
					notes: null
				}) satisfies SetPrescription;
			const plan = withStrength(workoutDay(), (session) => {
				session.exercises[0]!.sets.push(
					// 0.75 × 141 = 105.75 kg, and 0.7 × 143 = 100.1 kg: each to the nearest 2.5 kg.
					percent(0.75, 141, 'measured'),
					percent(0.7, 143, 'estimated')
				);
			});
			const { owner, strength } = await seedWorkoutDay(db, plan);
			const sets = (await strengthKit(db, owner, strength.lineage)).exercises[0]!.sets.slice(4);
			expect(sets.map((s) => [s.prescribedWeight, s.load, s.line])).toEqual([
				[
					{ value: 105, unit: 'kg', basis: 'measured' },
					{ kind: 'percent_1rm', fraction: 0.75 },
					'1 × 5'
				],
				[
					{ value: 100, unit: 'kg', basis: 'estimated' },
					{ kind: 'percent_1rm', fraction: 0.7 },
					'1 × 5'
				]
			]);
		});
	});

	it("gives the plank's sets 45 seconds and no reps; the pull-up loads as bodyweight", async () => {
		await withRollback(async (db) => {
			const { owner, strength } = await seedWorkoutDay(db);
			const kit = await strengthKit(db, owner, strength.lineage);
			const [pullUp, plank] = kit.exercises.slice(3);
			expect(pullUp!.exercise).toMatchObject({ loadType: 'bodyweight', measure: 'reps' });
			expect(plank!.exercise).toMatchObject({ measure: 'time', restClass: 'timed' });
			expect(plank!.sets).toHaveLength(3);
			for (const set of plank!.sets) {
				expect(set).toMatchObject({ seconds: 45, repsMin: null, repsMax: null, metres: null });
			}
		});
	});

	it('takes the previous sets only from the last completed workout', async () => {
		await withRollback(async (db) => {
			const { owner, strength, ids } = await seedWorkoutDay(db);
			const squat = ids.back_squat;
			const day = (days: number) => utc(addDays(TODAY, -days), '17:00');
			await logStrength(db, owner, { startedAt: day(7) }, [
				{ exercise: squat, weight: 60, reps: 5, warmup: true },
				{ exercise: squat, weight: 100, reps: 5, rpe: 8 },
				{ exercise: squat, weight: 100, reps: 5, skipped: true },
				{ exercise: squat, weight: 100, reps: 5, deleted: true },
				{ exercise: ids.leg_press, weight: 140, reps: 10 }
			]);
			// Newer, but none of them is a completed workout: in progress, abandoned, deleted.
			await logStrength(db, owner, { startedAt: day(1), status: 'in_progress' }, [
				{ exercise: squat, weight: 120, reps: 5 }
			]);
			await logStrength(db, owner, { startedAt: day(2), status: 'abandoned' }, [
				{ exercise: squat, weight: 115, reps: 5 }
			]);
			await logStrength(db, owner, { startedAt: day(3), deleted: true }, [
				{ exercise: squat, weight: 110, reps: 5 }
			]);
			// Completed, but its only squat set was skipped.
			await logStrength(db, owner, { startedAt: day(4) }, [
				{ exercise: squat, weight: 105, reps: 5, skipped: true }
			]);

			const kit = await strengthKit(db, owner, strength.lineage);
			const done = { seconds: null, metres: null, assistance: null, unit: 'kg', missedReps: 0 };
			expect(kit.exercises[0]!.previous).toEqual({
				date: addDays(TODAY, -7),
				sets: [
					{ ...done, reps: 5, weight: 60, rpe: null, isWarmup: true, isExtra: false },
					{ ...done, reps: 5, weight: 100, rpe: 8, isWarmup: false, isExtra: false }
				]
			});
			expect(kit.exercises[1]!.previous?.sets.map((s) => s.weight)).toEqual([140]);
			expect(kit.exercises[2]!.previous).toBeNull();
		});
	});

	it('labels the best e1RM estimated, beside the prior bests and most reps', async () => {
		await withRollback(async (db) => {
			const { owner, strength, ids } = await seedWorkoutDay(db);
			await seedSquatHistory(db, owner, ids.back_squat);
			await logStrength(db, owner, { startedAt: utc(addDays(TODAY, -2), '17:00') }, [
				{ exercise: ids.pull_up, weight: null, reps: 9 },
				{ exercise: ids.pull_up, weight: null, reps: 11, warmup: true },
				{ exercise: ids.pull_up, weight: 10, reps: 12 }
			]);
			const [squat, , , pullUp] = (await strengthKit(db, owner, strength.lineage)).exercises;
			expect(squat!.bestE1rm).toEqual({ kg: 125, estimated: true });
			expect(squat!.priorBests).toEqual([
				{ reps: 3, weightKg: 110, date: addDays(TODAY, -21) },
				{ reps: 5, weightKg: 100, date: addDays(TODAY, -7) }
			]);
			expect(squat!.mostReps).toBeNull();
			// Most reps counts working sets with no weight added: not the warm-up, not the 12 at +10 kg.
			expect(pullUp!.mostReps).toBe(9);
		});
	});

	it('takes a bounded number of queries for a six-exercise session', async () => {
		const sixth = withStrength(workoutDay(), (session) => {
			session.exercises.push({ ...session.exercises[2]!, exercise: { key: 'barbell_row' } });
		});
		const counts: number[] = [];
		for (const plan of [workoutDay(), sixth]) {
			await withRollback(async (db) => {
				const { owner, strength, ids } = await seedWorkoutDay(db, plan);
				await seedSquatHistory(db, owner, ids.back_squat);
				let kit: StartKit | null = null;
				const ctx = createContext('kit');
				const statements = await statementsOf(async () => {
					kit = await runWithContext(ctx, () => kitForLineage(owner, strength.lineage, deps(db)));
				});
				counts.push(statements.length);
				const exercises = (kit as StrengthKit | null)?.exercises.length;
				console.info(
					`kit of ${exercises} exercises: ${statements.length} queries; Server-Timing ${serverTimingHeader(ctx, performance.now() - ctx.startedAt)}`
				);
			});
		}
		// The program session and its children, the profile, the exercises, then one batched
		// history query each for last time, best e1RMs, rep maxes and most reps.
		expect(counts).toEqual([12, 12]);
	});
});

describe('run and other kits', () => {
	it('carries the run as planned, 14 segments expanded, and the class with its metrics', async () => {
		await withRollback(async (db) => {
			const { owner, run, other } = await seedWorkoutDay(db);
			const runKit = await kitForLineage(owner, run.lineage, deps(db));
			if (runKit?.kind !== 'run') throw new Error('a run kit');
			expect(runKit.run.segments).toHaveLength(4);
			expect(expandSegments(runKit.run.segments)).toHaveLength(14);

			const otherKit = await kitForLineage(owner, other.lineage, deps(db));
			if (otherKit?.kind !== 'other') throw new Error('an other kit');
			expect(otherKit.other).toEqual({
				kind: 'class',
				durationMinutes: 90,
				targetRpe: 7,
				metrics: [
					{ key: 'rounds', label: 'Rounds', unit: null, value: 6 },
					{ key: 'sparred', label: 'Sparred', unit: null, value: false }
				]
			});
		});
	});
});

describe('which session', () => {
	it("returns an older version's session id as its pinned row, and a lineage as the current one", async () => {
		await withRollback(async (db) => {
			const { owner, strength } = await seedWorkoutDay(db);
			if (strength.kind !== 'strength') throw new Error('a strength session');
			await adjustPrescription(
				owner,
				{
					sessionLineage: strength.lineage,
					plannedExerciseLineage: strength.exercises[1]!.lineage,
					position: 1,
					restSeconds: 150
				},
				{ version: 1, today: TODAY },
				{ db }
			);
			const legPressRest = (kit: StartKit | null) =>
				kit?.kind === 'strength' ? kit.exercises[1]!.sets[0]!.restSeconds : null;

			const pinned = await kitForSession(owner, strength.id, deps(db));
			expect(pinned).toMatchObject({ plannedSessionId: strength.id, versionNumber: 1 });
			expect(legPressRest(pinned)).toBe(120);

			const current = await kitForLineage(owner, strength.lineage, deps(db));
			expect(current).toMatchObject({ plannedLineage: strength.lineage, versionNumber: 2 });
			expect(current!.plannedSessionId).not.toBe(strength.id);
			expect(legPressRest(current)).toBe(150);
			expect(await kitForSession(owner, current!.plannedSessionId!, deps(db))).toEqual(current);
		});
	});

	it('adopts a workout in progress with the bests from before it, never its own synced sets', async () => {
		await withRollback(async (db) => {
			const { owner, programId, strength, ids } = await seedWorkoutDay(db);
			await seedSquatHistory(db, owner, ids.back_squat);
			const started = await strengthKit(db, owner, strength.lineage);
			// The first device starts the session and syncs a squat record and a first-ever pull-up set.
			await logStrength(
				db,
				owner,
				{
					startedAt: new Date(NOW.getTime() + 60_000),
					status: 'in_progress',
					planned: { sessionId: strength.id, lineageId: strength.lineage, programId }
				},
				[
					{ exercise: ids.back_squat, weight: 120, reps: 3, rpe: 9 },
					{ exercise: ids.pull_up, weight: null, reps: 12 }
				]
			);
			const later = { db, now: () => new Date(NOW.getTime() + 3600_000) };
			// The second device adopts it: the same kit, so the same PRs and 'First time'.
			expect(await kitForSession(owner, strength.id, later)).toEqual(started);
		});
	});

	it("is none for another owner's lineage or row, and for a malformed or unknown id", async () => {
		await withRollback(async (db) => {
			const { owner, strength } = await seedWorkoutDay(db);
			const other = await secondOwner(db);
			expect(await kitForLineage(other, strength.lineage, deps(db))).toBeNull();
			expect(await kitForSession(other, strength.id, deps(db))).toBeNull();
			for (const id of ['not-a-uuid', crypto.randomUUID()]) {
				expect(await kitForLineage(owner, id, deps(db))).toBeNull();
				expect(await kitForSession(owner, id, deps(db))).toBeNull();
			}
		});
	});

	it('answers the endpoint with the kit, never cached; anything else is a 404', async () => {
		await withCommitted(async (db) => {
			const { owner, strength } = await seedWorkoutDay(db);
			const get = (query: string) =>
				getKit({
					url: new URL(`http://localhost/api/workouts/kit?${query}`),
					locals: { session: { ownerId: owner } }
				} as never);

			for (const query of [`lineage=${strength.lineage}`, `session=${strength.id}`]) {
				const found = await get(query);
				expect(found.status, query).toBe(200);
				expect(found.headers.get('cache-control')).toBe('no-store');
				expect(await found.json()).toMatchObject({
					kind: 'strength',
					plannedSessionId: strength.id
				});
			}
			for (const query of [
				'lineage=not-a-uuid',
				`session=${crypto.randomUUID()}`,
				`lineage=${strength.lineage}&session=${strength.id}`,
				''
			]) {
				const missing = await get(query);
				expect(missing.status, query).toBe(404);
				expect(missing.headers.get('cache-control')).toBe('no-store');
				expect(await missing.json()).toEqual({ error: 'not_found' });
			}
		});
	});
});

describe('the shared fixture', () => {
	it('builds exactly the kits of tests/fixtures/workout-day.ts', async () => {
		await withRollback(async (db) => {
			const { owner, programId, strength, run, other, ids } = await seedWorkoutDay(db);
			await seedSquatHistory(db, owner, ids.back_squat);
			const expected = workoutDayKits({ date: TODAY, exerciseId: (key) => ids[key as never] });

			/** The server's ids as the fixture names them. */
			const normalised = (kit: StartKit | null, fixture: { session: string; lineage: string }) => {
				expect(kit).toMatchObject({ programId, versionNumber: 1 });
				const named = {
					...wire(kit!),
					programId: WORKOUT_DAY_IDS.programId,
					plannedSessionId: fixture.session,
					plannedLineage: fixture.lineage
				};
				return named.kind === 'strength'
					? {
							...named,
							exercises: named.exercises.map((e, i) => ({
								...e,
								plannedLineage: WORKOUT_DAY_IDS.exercises[i]
							}))
						}
					: named;
			};
			const kitOf = (lineage: string) => kitForLineage(owner, lineage, deps(db));

			expect(normalised(await kitOf(strength.lineage), WORKOUT_DAY_IDS.strength)).toEqual(
				expected.strength
			);
			expect(normalised(await kitOf(run.lineage), WORKOUT_DAY_IDS.run)).toEqual(expected.run);
			expect(normalised(await kitOf(other.lineage), WORKOUT_DAY_IDS.other)).toEqual(expected.other);
		});
	});
});

/** How a kit set's load reads: its kind where it carries one, else absolute or RPE-based. */
const kindOf = (set: KitSet) =>
	set.load?.kind ?? (set.prescribedWeight?.basis === 'absolute' ? 'absolute' : 'rpe_based');

describe('generated programs', () => {
	const library = new Map(CATALOGUE.map((e) => [e.key, e]));

	it.each(Object.keys(SCENARIOS) as ScenarioKey[])(
		'%s: builds a kit for every week-1 session, each load from its prescription',
		async (scenario) => {
			await withRollback(async (db) => {
				const owner = await makeOwner(db);
				const input = buildProgrammingInput(SCENARIOS[scenario](), { catalogue: CATALOGUE });
				const plan = generateProgram(input, {
					startsOn: SCENARIO_START,
					firstPlannedDay: SCENARIO_START
				});
				const { v1 } = await storePlan(db, owner, plan);
				const sessions = v1.blocks[0]!.weeks[0]!.sessions;
				expect(sessions.length).toBeGreaterThan(0);

				const emitted = {
					kinds: new Set(),
					roles: new Set(),
					measures: new Set(),
					loads: new Set()
				};
				const handled = {
					kinds: new Set(),
					roles: new Set(),
					measures: new Set(),
					loads: new Set()
				};
				for (const session of sessions) {
					const kit = await kitForLineage(owner, session.lineage, deps(db));
					expect(kit, session.title).toMatchObject({ kind: session.kind, versionNumber: 1 });
					if (session.kind !== 'strength' || kit?.kind !== 'strength') continue;

					expect(kit.exercises.map((e) => e.superset)).toEqual(
						session.exercises.map((e) => e.superset)
					);
					for (const [i, planned] of session.exercises.entries()) {
						const entry = kit.exercises[i]!;
						const meta = 'key' in planned.exercise ? library.get(planned.exercise.key) : null;
						expect(entry.exercise).toMatchObject({
							key: meta?.key,
							measure: meta?.measure,
							loadType: meta?.loadType
						});
						expect(entry).toMatchObject({
							previous: null,
							bestE1rm: null,
							priorBests: [],
							mostReps: null
						});
						emitted.measures.add(meta?.measure);
						emitted.loads.add(meta?.loadType);
						handled.measures.add(entry.exercise.measure);
						handled.loads.add(entry.exercise.loadType);

						const expected = planned.sets.flatMap((p) => Array.from({ length: p.sets }, () => p));
						expect(entry.sets).toHaveLength(expected.length);
						for (const [n, p] of expected.entries()) {
							const set = entry.sets[n]!;
							const options = { unit: 'kg' as const, oneRepMaxKg: null };
							// No weight unless the prescription computes one, with no history yet.
							expect(set.prescribedWeight?.value ?? null).toBe(prescribedLoad(p, options));
							expect(set.prescribedWeight === null).toBe(
								p.loadKind === 'rpe_based' || p.loadKind === 'from_e1rm'
							);
							expect(set.line).toBe(describePrescription(p, options).headline);
							emitted.kinds.add(p.loadKind);
							emitted.roles.add(p.role);
							handled.kinds.add(kindOf(set));
							handled.roles.add(set.role);
						}
					}
				}
				expect(handled).toEqual(emitted);
			});
		}
	);
});
