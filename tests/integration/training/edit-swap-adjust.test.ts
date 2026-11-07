/**
 * Swapping an exercise and adjusting a prescription on real Postgres (services/programs/
 * alternatives.ts and edits.ts): the alternatives follow the owner's equipment and dislikes and
 * explain an empty list; a one-off swap changes one session and records no preference, while
 * 'never prescribe this again' saves a dislike and swaps the exercise from today on; every
 * discipline's prescription can be adjusted. Each edit is a new version with one decision, and
 * every older version stays as it was.
 *
 * The plan runs Monday 9 to Sunday 22 November 2026, two weeks alike, and each call says which
 * day is today.
 */
import { describe, expect, it } from 'vitest';
import { addDays } from '../../../src/lib/domain/calendar';
import { CATALOGUE } from '../../../src/lib/domain/exercises/index';
import { DISLIKED, isEligible, libraryOf } from '../../../src/lib/domain/programming/eligibility';
import type {
	PlannedExercisePlan,
	ProgramPlan,
	SessionPlan,
	SetPrescription,
	WeekPlan
} from '../../../src/lib/domain/training/types';
import type { Executor } from '../../../src/lib/server/db';
import { resolveKeys } from '../../../src/lib/server/services/exercises/index';
import { saveEquipment, saveExercisePreferences } from '../../../src/lib/server/services/profile';
import { programmingInputFor } from '../../../src/lib/server/services/programs/alternatives';
import {
	adjustPrescription,
	adjustRunSegment,
	adjustSessionDetails,
	alternativesFor,
	createProgramFromPlan,
	getProgramVersion,
	NOTHING_CHANGED,
	swapExercise,
	type ProgramVersion,
	type StoredSession
} from '../../../src/lib/server/services/programs/index';
import { listExercisePreferences } from '../../../src/lib/server/services/training/preferences';
import { TrainingInputError } from '../../../src/lib/server/services/training/shared';
import {
	FIXTURE_COMMITMENT,
	FIXTURE_GOAL
} from '../../../src/lib/server/test-support/program-fixtures';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const MONDAY = '2026-11-09';
const day = (n: number) => addDays(MONDAY, n);
const [MON, , WED] = [day(0), day(1), day(2)];

// ---- the plan -------------------------------------------------------------------------------

const set = (over: Partial<SetPrescription>): SetPrescription => ({
	role: 'working',
	sets: 3,
	repsMin: 5,
	repsMax: 5,
	seconds: null,
	metres: null,
	targetRpe: 7,
	loadKind: 'rpe_based',
	loadValue: null,
	loadUnit: null,
	loadBasis: null,
	reference1rm: null,
	reference1rmUnit: null,
	restSeconds: 120,
	tempo: null,
	notes: null,
	...over
});

/** Back squat from a measured 1RM of 140 kg: a top set at 80 %, back-offs from the estimate. */
const backSquat = (): PlannedExercisePlan => ({
	exercise: { key: 'back_squat' },
	baselineLift: 'back_squat',
	superset: null,
	substitutedFrom: null,
	substitutionReason: null,
	instructions: 'Brace before each rep.',
	notes: null,
	sets: [
		set({
			role: 'top',
			sets: 1,
			targetRpe: 8,
			loadKind: 'percent_1rm',
			loadValue: 0.8,
			loadBasis: 'measured',
			reference1rm: 140,
			reference1rmUnit: 'kg'
		}),
		set({ role: 'back_off', loadKind: 'from_e1rm', loadValue: 0.7 })
	]
});

const powerClean = (): PlannedExercisePlan => ({
	...backSquat(),
	exercise: { key: 'power_clean' },
	baselineLift: null,
	instructions: null,
	sets: [set({ sets: 5, repsMin: 2, repsMax: 2 })]
});

const base = (date: string, title: string, minutes: number, rpe: number) => ({
	date,
	title,
	timeOfDay: 'morning' as const,
	orderInDay: 1,
	customDiscipline: null,
	estMinutes: minutes,
	estLoad: minutes * rpe,
	targetRpe: rpe,
	source: 'generator' as const,
	commitmentRef: null,
	instructions: null,
	notes: null
});

const strength = (date: string, title: string, exercises: PlannedExercisePlan[]): SessionPlan => ({
	...base(date, title, 45, 8),
	kind: 'strength',
	type: 'strength',
	discipline: 'strength',
	intensity: 'hard',
	exercises
});

/** 10 minutes' warm-up, 6 × (400 m, 90 s jog), 10 minutes' cool-down. */
const intervals = (date: string): SessionPlan => {
	const segment = {
		repeatGroup: null,
		repeats: null,
		distanceMetres: null,
		durationSeconds: null,
		paceMinSecondsPerKm: null,
		paceMaxSecondsPerKm: null,
		hrZone: null,
		targetRpe: null
	};
	return {
		...base(date, 'Intervals', 40, 7),
		kind: 'run',
		type: 'interval_run',
		discipline: 'running',
		intensity: 'hard',
		segments: [
			{ ...segment, kind: 'warm_up', durationSeconds: 600, hrZone: 2 },
			{ ...segment, kind: 'interval', repeatGroup: 1, repeats: 6, distanceMetres: 400 },
			{ ...segment, kind: 'recovery', repeatGroup: 1, repeats: 6, durationSeconds: 90 },
			{ ...segment, kind: 'cool_down', durationSeconds: 600, hrZone: 2 }
		]
	};
};

const muayThai = (date: string): SessionPlan => ({
	...base(date, 'Muay Thai', 90, 8),
	timeOfDay: 'evening',
	kind: 'other',
	type: 'muay_thai',
	discipline: 'muay_thai',
	intensity: 'hard',
	source: 'commitment',
	commitmentRef: FIXTURE_COMMITMENT,
	details: { kind: 'pad_work', durationMinutes: 90, targetRpe: 8, metrics: [], notes: null }
});

/** Lower A on Monday, intervals on Tuesday, Lower B on Thursday, Muay Thai on Saturday. */
const week = (monday: string): WeekPlan => {
	const d = (n: number) => addDays(monday, n);
	return {
		kind: 'baseline',
		startsOn: monday,
		endsOn: d(6),
		targets: { rpeCap: 8, volumeFactor: 1, loadStep: 0, runVolumeFactor: 1 },
		sessions: [
			strength(d(0), 'Lower A', [backSquat()]),
			intervals(d(1)),
			strength(d(3), 'Lower B', [backSquat(), powerClean()]),
			muayThai(d(5))
		]
	};
};

const plan = (): ProgramPlan => ({
	title: 'Edits fixture',
	startsOn: MONDAY,
	firstPlannedDay: MONDAY,
	blocks: [
		{
			phase: 'baseline',
			name: 'Baseline',
			startsOn: MONDAY,
			endsOn: day(13),
			outline: false,
			goalRefs: [FIXTURE_GOAL],
			progression: {},
			weeks: [week(MONDAY), week(day(7))]
		}
	],
	decisions: [
		{
			kind: 'program_purpose',
			ruleKey: 'blocks.baseline_first',
			summary: 'Week 1 establishes your baselines',
			why: 'Your working weights are not known yet.',
			decidedBy: 'rules',
			refs: ['blocks.0'],
			evidence: {}
		}
	]
});

async function store(db: Executor, owner: string) {
	const created = await createProgramFromPlan(owner, plan(), { source: 'rules' }, { db });
	return created.programId;
}

const versionOf = (db: Executor, owner: string, programId: string, n: number) =>
	getProgramVersion(owner, programId, n, { db });

/** A week's session by title. */
const titled = (version: ProgramVersion, w: number, title: string): StoredSession =>
	version.blocks[0]!.weeks[w]!.sessions.find((s) => s.title === title)!;

function exercisesOf(session: StoredSession) {
	if (session.kind !== 'strength') throw new Error(`${session.title} is not a strength session`);
	return session.exercises;
}

const lowerA = (v: ProgramVersion, w = 0) => exercisesOf(titled(v, w, 'Lower A'))[0]!;

/** Catalogue ids by key. */
async function ids(db: Executor, ...keys: string[]): Promise<string[]> {
	const found = await resolveKeys(keys, { db });
	return keys.map((key) => found.get(key)!.id);
}

/** The field errors a call was refused with (fails the test if it was not refused so). */
async function fieldErrors(promise: Promise<unknown>): Promise<Record<string, string>> {
	const error = await promise.then(
		() => null,
		(err: unknown) => err
	);
	if (!(error instanceof TrainingInputError)) throw error ?? new Error('expected a refusal');
	return error.errors;
}

/** Version 1 as it read before the edit, now that it is no longer current. */
const asOlder = (v: ProgramVersion): ProgramVersion => ({
	...v,
	version: { ...v.version, current: false }
});

const byKey = new Map(CATALOGUE.map((e) => [e.key, e]));

// ---- alternatives ---------------------------------------------------------------------------

describe('alternativesFor', () => {
	it('offers back squat’s dumbbell alternatives for a dumbbells-only owner, never a disliked or excluded one', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await saveEquipment(
				owner,
				{ gymType: null, equipment: ['dumbbells'], homeEquipment: [], notes: null },
				{ db }
			);
			await saveExercisePreferences(
				owner,
				{ items: [{ exercise: 'Dumbbell front squat', sentiment: 'dislike' }] },
				{ db }
			);
			const programId = await store(db, owner);
			const v1 = await versionOf(db, owner, programId, 1);
			const lower = titled(v1, 0, 'Lower A');

			const { alternatives, blocked } = await alternativesFor(
				owner,
				{ sessionLineage: lower.lineage, plannedExerciseLineage: lowerA(v1).lineage },
				{ db }
			);
			expect(blocked).toBeNull();
			const [goblet] = await ids(db, 'goblet_squat');
			expect(alternatives[0]).toEqual({
				id: goblet,
				key: 'goblet_squat',
				name: 'Goblet squat',
				reason: 'Does the same job as back squat'
			});
			const keys = alternatives.map((a) => a.key);
			expect(keys).toEqual(expect.arrayContaining(['goblet_squat', 'split_squat']));
			for (const key of keys) {
				const exercise = byKey.get(key)!;
				expect(['squat', 'lunge']).toContain(exercise.pattern);
				expect(exercise.equipment.every((item) => item === 'dumbbells')).toBe(true);
			}
			expect(keys).not.toContain('dumbbell_front_squat');
			expect(keys).not.toContain('front_squat');
			expect(keys).not.toContain('back_squat');
			// Every id is the library row of its key.
			const rows = await resolveKeys(keys, { db });
			expect(alternatives.map((a) => a.id)).toEqual(keys.map((k) => rows.get(k)!.id));
		});
	});

	it('offers nothing for the power clean with bodyweight only, and says why', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await saveEquipment(
				owner,
				{ gymType: 'none', equipment: [], homeEquipment: [], notes: null },
				{ db }
			);
			const programId = await store(db, owner);
			const v1 = await versionOf(db, owner, programId, 1);
			const lowerB = titled(v1, 0, 'Lower B');
			const clean = exercisesOf(lowerB)[1]!;
			expect(clean.exercise).toEqual({ key: 'power_clean' });

			const result = await alternativesFor(
				owner,
				{ sessionLineage: lowerB.lineage, plannedExerciseLineage: clean.lineage },
				{ db }
			);
			expect(result.alternatives).toEqual([]);
			expect(result.blocked).toMatch(/^Needs a barbell\b.* or dumbbells$/);
		});
	});
});

// ---- swaps ----------------------------------------------------------------------------------

describe('swapExercise', () => {
	it('swaps once: version 2 has the alternative in that session only, and no preference is saved', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const programId = await store(db, owner);
			const v1 = await versionOf(db, owner, programId, 1);
			const [goblet] = await ids(db, 'goblet_squat');

			const swapped = await swapExercise(
				owner,
				{
					sessionLineage: titled(v1, 0, 'Lower A').lineage,
					plannedExerciseLineage: lowerA(v1).lineage,
					toExerciseId: goblet,
					scope: 'once'
				},
				{ version: 1, today: MON },
				{ db }
			);
			expect(swapped).toMatchObject({ programId, number: 2 });

			const v2 = await versionOf(db, owner, programId, 2);
			const copy = lowerA(v2);
			expect(copy).toMatchObject({
				lineage: lowerA(v1).lineage,
				exercise: { key: 'goblet_squat' },
				substitutedFrom: { key: 'back_squat' },
				substitutionReason: 'situational',
				// Its loads were of the back squat's 1RM: now they are by RPE, at the same RPE.
				baselineLift: null,
				instructions: null
			});
			expect(copy.sets).toEqual([
				set({ role: 'top', sets: 1, targetRpe: 8 }),
				set({ role: 'back_off', targetRpe: 7 })
			]);
			// Lower B this week and Lower A next week keep the back squat; next week is not copied.
			expect(exercisesOf(titled(v2, 0, 'Lower B'))[0]!.exercise).toEqual({ key: 'back_squat' });
			expect(lowerA(v2, 1)).toEqual(lowerA(v1, 1));
			expect(v2.blocks[0]!.weeks[1]!.id).toBe(v1.blocks[0]!.weeks[1]!.id);
			expect(await versionOf(db, owner, programId, 1)).toEqual(asOlder(v1));
			expect(await listExercisePreferences(owner, { db })).toEqual([]);

			expect(v2.decisions).toEqual([
				expect.objectContaining({
					kind: 'exercise_swapped',
					summary: 'Swapped Back squat for Goblet squat',
					why: 'You swapped Back squat for Goblet squat in Lower A on Mon, this session only. No reason given.',
					decidedBy: 'owner',
					affected: [titled(v1, 0, 'Lower A').lineage, lowerA(v1).lineage]
				})
			]);
		});
	});

	it('never again: saves one dislike and swaps every session from today, leaving earlier ones and version 1 as they were', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const programId = await store(db, owner);
			const v1 = await versionOf(db, owner, programId, 1);
			const [goblet, squat] = await ids(db, 'goblet_squat', 'back_squat');
			const lowerB = titled(v1, 0, 'Lower B');

			const swapped = await swapExercise(
				owner,
				{
					sessionLineage: lowerB.lineage,
					plannedExerciseLineage: exercisesOf(lowerB)[0]!.lineage,
					toExerciseId: goblet,
					scope: 'never_again',
					reason: 'My lower back flares up'
				},
				{ version: 1, today: WED },
				{ db }
			);
			expect(swapped.number).toBe(2);

			const preferences = await listExercisePreferences(owner, { db });
			expect(preferences).toEqual([
				expect.objectContaining({
					exercise: 'Back squat',
					exerciseId: squat,
					sentiment: 'dislike',
					reason: 'My lower back flares up',
					source: 'swap'
				})
			]);

			const v2 = await versionOf(db, owner, programId, 2);
			// Thursday's Lower B, and both sessions next week: three sessions from Wednesday on.
			const swappedOut = [
				exercisesOf(titled(v2, 0, 'Lower B'))[0]!,
				lowerA(v2, 1),
				exercisesOf(titled(v2, 1, 'Lower B'))[0]!
			];
			for (const exercise of swappedOut) {
				expect(exercise).toMatchObject({
					exercise: { key: 'goblet_squat' },
					substitutedFrom: { key: 'back_squat' },
					substitutionReason: 'dislike'
				});
			}
			// The power clean beside it stays; Monday's Lower A, already past, keeps the back squat.
			expect(exercisesOf(titled(v2, 0, 'Lower B'))[1]!.exercise).toEqual({ key: 'power_clean' });
			expect({ ...lowerA(v2), id: lowerA(v1).id }).toEqual(lowerA(v1));
			// Both weeks were copied.
			expect(v2.blocks[0]!.weeks.map((w) => w.id)).not.toContain(v1.blocks[0]!.weeks[0]!.id);
			expect(v2.blocks[0]!.weeks.map((w) => w.id)).not.toContain(v1.blocks[0]!.weeks[1]!.id);
			expect(await versionOf(db, owner, programId, 1)).toEqual(asOlder(v1));

			expect(v2.decisions).toEqual([
				expect.objectContaining({
					kind: 'preference_recorded',
					summary: 'Back squat is never prescribed again',
					why: 'You asked for Back squat never to be prescribed again, so it is saved as a dislike and swapped for Goblet squat in 3 sessions from today. My lower back flares up.'
				})
			]);

			// The generator's input now rules the back squat out.
			const input = await programmingInputFor(owner, { db });
			expect(input.dislikes).toContain('back_squat');
			const entry = libraryOf(input).find((e) => e.key === 'back_squat')!;
			expect(isEligible(entry, input)).toEqual({
				ok: false,
				reasons: [{ kind: 'dislike', text: DISLIKED }]
			});
		});
	});

	it('refuses a target that is not an eligible alternative, at toExerciseId', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await saveEquipment(
				owner,
				{ gymType: null, equipment: ['dumbbells'], homeEquipment: [], notes: null },
				{ db }
			);
			const programId = await store(db, owner);
			const v1 = await versionOf(db, owner, programId, 1);
			const [front, bench] = await ids(db, 'front_squat', 'bench_press');
			const swap = (toExerciseId: string, scope: 'once' | 'never_again') =>
				swapExercise(
					owner,
					{
						sessionLineage: titled(v1, 0, 'Lower A').lineage,
						plannedExerciseLineage: lowerA(v1).lineage,
						toExerciseId,
						scope
					},
					{ version: 1, today: MON },
					{ db }
				);

			expect(await fieldErrors(swap(front!, 'once'))).toEqual({
				toExerciseId: 'Needs a barbell and a squat rack'
			});
			expect(await fieldErrors(swap(bench!, 'never_again'))).toEqual({
				toExerciseId: 'Not an alternative to back squat'
			});
			expect((await versionOf(db, owner, programId, 1)).version.current).toBe(true);
			expect(await listExercisePreferences(owner, { db })).toEqual([]);
		});
	});
});

// ---- adjustments ----------------------------------------------------------------------------

describe('adjustPrescription', () => {
	it('refuses RPE 11 and reps that run high to low, as field errors', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const programId = await store(db, owner);
			const v1 = await versionOf(db, owner, programId, 1);
			const adjust = (values: Record<string, unknown>) =>
				adjustPrescription(
					owner,
					{
						sessionLineage: titled(v1, 0, 'Lower A').lineage,
						plannedExerciseLineage: lowerA(v1).lineage,
						position: 1,
						...values
					},
					{ version: 1, today: MON },
					{ db }
				);

			expect(await fieldErrors(adjust({ targetRpe: 11 }))).toEqual({
				targetRpe: 'RPE 5 to 10, in half steps'
			});
			expect(await fieldErrors(adjust({ repsMin: 8 }))).toEqual({
				repsMax: 'The range runs low to high'
			});
			expect(await fieldErrors(adjust({ targetRpe: 8 }))).toEqual({
				sessionLineage: NOTHING_CHANGED
			});
			expect((await versionOf(db, owner, programId, 1)).version.current).toBe(true);
		});
	});

	it('saves a valid adjustment as version 2, with the session’s time worked out again', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const programId = await store(db, owner);
			const v1 = await versionOf(db, owner, programId, 1);
			const lower = titled(v1, 0, 'Lower A');

			const adjusted = await adjustPrescription(
				owner,
				{
					sessionLineage: lower.lineage,
					plannedExerciseLineage: lowerA(v1).lineage,
					position: 1,
					sets: 2,
					targetRpe: 8.5,
					restSeconds: 180
				},
				{ version: 1, today: MON },
				{ db }
			);
			expect(adjusted.number).toBe(2);

			const v2 = await versionOf(db, owner, programId, 2);
			expect(lowerA(v2).sets).toEqual([
				{ ...lowerA(v1).sets[0]!, sets: 2, targetRpe: 8.5, restSeconds: 180 },
				lowerA(v1).sets[1]
			]);
			// A 10-minute warm-up, 2 × (5 reps + 3:00) and 3 × (5 reps + 2:00): 24 minutes.
			expect(titled(v2, 0, 'Lower A')).toMatchObject({ estMinutes: 24, estLoad: 24 * 8 });
			expect(await versionOf(db, owner, programId, 1)).toEqual(asOlder(v1));
			expect(v2.decisions).toEqual([
				expect.objectContaining({
					kind: 'prescription_adjusted',
					summary: 'Adjusted Back squat, top set',
					why: 'You changed Back squat, top set: 1 × 5 @ RPE 8, 112.5 kg, rest 2:00 → 2 × 5 @ RPE 8.5, 112.5 kg, rest 3:00. No reason given.'
				})
			]);
		});
	});
});

describe('adjustRunSegment', () => {
	it('takes 5 repeats and a pace range as version 2, with the run’s time worked out again', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const programId = await store(db, owner);
			const v1 = await versionOf(db, owner, programId, 1);
			const run = titled(v1, 0, 'Intervals');

			const adjusted = await adjustRunSegment(
				owner,
				{
					sessionLineage: run.lineage,
					position: 2,
					repeats: 5,
					paceMinSecondsPerKm: 240,
					paceMaxSecondsPerKm: 250,
					reason: 'Legs are heavy'
				},
				{ version: 1, today: MON },
				{ db }
			);
			expect(adjusted.number).toBe(2);

			const v2 = await versionOf(db, owner, programId, 2);
			const copy = titled(v2, 0, 'Intervals');
			if (copy.kind !== 'run' || run.kind !== 'run') throw new Error('not a run');
			// The group's recovery jog repeats alike.
			expect(copy.segments.map((s) => s.repeats)).toEqual([null, 5, 5, null]);
			expect(copy.segments[1]).toMatchObject({
				paceMinSecondsPerKm: 240,
				paceMaxSecondsPerKm: 250
			});
			// 20 minutes of warm-up and cool-down, 5 × (400 m at 4:05 /km + 1:30): 36 minutes.
			expect(copy).toMatchObject({ estMinutes: 36, estLoad: 36 * 7 });
			expect(await versionOf(db, owner, programId, 1)).toEqual(asOlder(v1));
			expect(v2.decisions).toEqual([
				expect.objectContaining({
					kind: 'prescription_adjusted',
					summary: 'Adjusted Intervals, segment 2',
					why: 'You changed Intervals, segment 2: 6 × Interval 400 m → 5 × Interval 400 m, 4:00–4:10 /km. Legs are heavy.'
				})
			]);
		});
	});

	it('refuses heart-rate zone 6, as a field error', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const programId = await store(db, owner);
			const v1 = await versionOf(db, owner, programId, 1);
			const errors = await fieldErrors(
				adjustRunSegment(
					owner,
					{ sessionLineage: titled(v1, 0, 'Intervals').lineage, position: 1, hrZone: 6 },
					{ version: 1, today: MON },
					{ db }
				)
			);
			expect(errors).toEqual({ hrZone: 'Heart-rate zone 1 to 5' });
		});
	});
});

describe('adjustSessionDetails', () => {
	it('shortens Muay Thai from 90 to 60 minutes at RPE 6 as version 2, with its load worked out again', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const programId = await store(db, owner);
			const v1 = await versionOf(db, owner, programId, 1);
			const session = titled(v1, 0, 'Muay Thai');

			const adjusted = await adjustSessionDetails(
				owner,
				{ sessionLineage: session.lineage, durationMinutes: 60, targetRpe: 6 },
				{ version: 1, today: MON },
				{ db }
			);
			expect(adjusted.number).toBe(2);

			const v2 = await versionOf(db, owner, programId, 2);
			expect(titled(v2, 0, 'Muay Thai')).toMatchObject({
				estMinutes: 60,
				targetRpe: 6,
				estLoad: 360,
				details: { kind: 'pad_work', durationMinutes: 60, targetRpe: 6 }
			});
			expect(await versionOf(db, owner, programId, 1)).toEqual(asOlder(v1));
			expect(v2.decisions).toEqual([
				expect.objectContaining({
					kind: 'prescription_adjusted',
					summary: 'Adjusted Muay Thai',
					why: 'You changed Muay Thai: 90 min @ RPE 8 → 60 min @ RPE 6. No reason given.'
				})
			]);
		});
	});
});
