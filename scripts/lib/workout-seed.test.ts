import { describe, expect, it } from 'vitest';
import { project } from '../../src/lib/domain/workout/project';
import { strengthTable } from '../../src/lib/domain/workout/reducers/tables';
import { syncRequestSchema } from '../../src/lib/domain/workout/schemas';
import { workoutDayKits } from '../../tests/fixtures/workout-day';
import {
	activeWorkoutSeed,
	adHoc,
	FALLBACK_RPE,
	FALLBACK_WEIGHT,
	finishedWorkout,
	loggedSet
} from './workout-seed';

/** The fixture with a UUID per catalogue key, as the database gives them. */
const ids = new Map<string, string>();
const kits = workoutDayKits({
	date: '2026-11-10',
	exerciseId: (key) => {
		if (!ids.has(key)) ids.set(key, crypto.randomUUID());
		return ids.get(key)!;
	}
});
const plannedSets = kits.strength.exercises.reduce((sum, slot) => sum + slot.sets.length, 0);
const NOW = Date.parse('2026-11-10T18:00:00Z');

describe('adHoc', () => {
	it('takes the planned session off the kit and off every slot, and leaves the rest', () => {
		const kit = adHoc(kits.strength);
		expect(kits.strength.plannedSessionId).not.toBeNull();
		expect(kits.strength.exercises.some((slot) => slot.plannedLineage !== null)).toBe(true);
		expect(kit).toMatchObject({ plannedLineage: null, plannedSessionId: null, programId: null });
		expect(kit.exercises.map((slot) => slot.plannedLineage)).toEqual(kit.exercises.map(() => null));
		expect(kit.exercises.map((slot) => slot.exercise)).toEqual(
			kits.strength.exercises.map((slot) => slot.exercise)
		);
		expect(adHoc(kits.run)).toMatchObject({ kind: 'run', run: kits.run.run, programId: null });
	});
});

describe('loggedSet', () => {
	const slot = (key: string) => kits.strength.exercises.find((s) => s.exercise.key === key)!;

	it("logs a set's amount by the exercise's measure and its load by its load type", () => {
		const squat = slot('back_squat');
		const top = squat.sets.find((set) => set.prescribedWeight !== null)!;
		expect(loggedSet(squat, top, 'kg')).toMatchObject({
			reps: top.repsMin,
			seconds: null,
			weight: top.prescribedWeight!.value,
			assistance: null,
			rpe: top.targetRpe ?? FALLBACK_RPE
		});
		const plank = slot('plank');
		expect(loggedSet(plank, plank.sets[0]!, 'kg')).toMatchObject({
			reps: null,
			seconds: plank.sets[0]!.seconds,
			weight: null
		});
	});

	it('lifts the fallback weight when the kit computes no load for an external-load set', () => {
		const press = slot('leg_press');
		const set = { ...press.sets[0]!, prescribedWeight: null };
		expect(loggedSet(press, set, 'kg').weight).toBe(FALLBACK_WEIGHT);
	});
});

describe('finishedWorkout', () => {
	const { workoutId, mutations } = finishedWorkout(kits.strength, NOW - 3_600_000);

	it('is a valid sync request: start, every planned set, finish, a minute apart', () => {
		for (let i = 0; i < mutations.length; i += 20) {
			const batch = { v: 1, mutations: mutations.slice(i, i + 20) };
			expect(syncRequestSchema.safeParse(batch).error?.issues ?? []).toEqual([]);
		}
		expect(mutations.map((m) => m.type)).toEqual([
			'workout.start',
			...Array.from({ length: plannedSets }, () => 'set.log'),
			'workout.finish'
		]);
		expect(new Set(mutations.map((m) => m.workoutId))).toEqual(new Set([workoutId]));
		expect(new Set(mutations.map((m) => m.id)).size).toBe(mutations.length);
		expect(Date.parse(mutations.at(-1)!.at) - Date.parse(mutations[0]!.at)).toBe(
			(mutations.length - 1) * 60_000
		);
	});

	it('projects to a completed ad-hoc workout with every planned set logged', () => {
		const view = project(strengthTable, {
			workoutId,
			kit: adHoc(kits.strength),
			canonical: null,
			pending: mutations
		});
		expect(view?.workout).toMatchObject({ status: 'completed', plannedSessionId: null });
		expect(view?.slots.map((slot) => slot.sets.length)).toEqual(
			kits.strength.exercises.map((slot) => slot.sets.length)
		);
	});
});

describe('activeWorkoutSeed', () => {
	const seed = activeWorkoutSeed(kits.strength, NOW, { minutesAgo: 12 });

	it('is a workout in progress, on its first exercise, its stopwatch running from its start', () => {
		const started = NOW - 12 * 60_000;
		expect(seed.record).toMatchObject({
			id: seed.workoutId,
			kind: 'strength',
			status: 'in_progress',
			startedAt: new Date(started).toISOString(),
			finishedAt: null,
			canonical: null,
			kit: adHoc(kits.strength),
			device: {
				position: 1,
				rest: null,
				stopwatch: { startedAt: started, accumulatedMs: 0, runningSince: started }
			}
		});
	});

	it('queues its workout.start, unsent, which projects to the active workout', () => {
		expect(seed.entries).toHaveLength(1);
		const [{ envelope, attempts }] = seed.entries as [(typeof seed.entries)[number]];
		expect(envelope).toMatchObject({ type: 'workout.start', workoutId: seed.workoutId });
		expect(attempts).toBe(0);
		expect(syncRequestSchema.safeParse({ v: 1, mutations: [envelope] }).success).toBe(true);
		const view = project(strengthTable, {
			workoutId: seed.workoutId,
			kit: seed.record.kit,
			canonical: null,
			pending: [envelope],
			device: seed.record.device
		});
		expect(view?.workout.status).toBe('in_progress');
		expect(view?.slots).toHaveLength(kits.strength.exercises.length);
	});

	it('keeps the workout id it is given, so every write of one seed is the same workout', () => {
		const again = activeWorkoutSeed(kits.strength, NOW, { workoutId: seed.workoutId });
		expect(again.record.id).toBe(seed.workoutId);
		expect(again.entries[0]!.envelope.id).toBe(seed.workoutId);
	});
});
