import { describe, expect, it } from 'vitest';
import { createMutation } from '#lib/domain/workout/mutations.ts';
import type { Mutation } from '#lib/domain/workout/mutations.ts';
import { applyLocal, replay, viewOf } from '#lib/domain/workout/project.ts';
import { strengthTable } from '#lib/domain/workout/reducers/tables.ts';
import type { KitSet, WorkoutView } from '#lib/domain/workout/index.ts';
import { workoutDayKits } from '../../../../tests/fixtures/workout-day';
import { ALL_DONE, announcement, nextLine, targetWords, upNextWords } from './up-next-words';

const KIT = workoutDayKits({ date: '2026-11-06' }).strength;
const [SQUAT, LEG_PRESS, RDL, PULL_UP, PLANK] = KIT.exercises.map((e) => e.sets) as KitSet[][];
const W = '00000000-0000-4000-8000-0000000000f1';

let ids = 0;
const fresh = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`;

/** The fixture's workout with one set logged at each position given, in order, then at `position`. */
function view(logged: number[], position = logged.at(-1) ?? 1): WorkoutView {
	const at = new Date(Date.UTC(2026, 10, 6, 18)).toISOString();
	const start = createMutation(
		'workout.start',
		{
			workoutId: W,
			entityId: W,
			at,
			payload: {
				kind: 'strength',
				title: KIT.title,
				sessionType: KIT.sessionType,
				discipline: KIT.discipline,
				plannedSessionId: KIT.plannedSessionId,
				plannedLineage: KIT.plannedLineage,
				programId: KIT.programId
			}
		},
		fresh
	);
	const counts = new Map<number, number>();
	const sets: Mutation[] = logged.map((p) => {
		const slot = KIT.exercises[p - 1]!;
		const setIndex = (counts.get(p) ?? 0) + 1;
		counts.set(p, setIndex);
		const time = slot.exercise.measure === 'time';
		return createMutation(
			'set.log',
			{
				workoutId: W,
				at,
				payload: {
					position: p,
					plannedLineage: slot.plannedLineage,
					setIndex,
					exerciseId: slot.exercise.id,
					reps: time ? null : 8,
					seconds: time ? 45 : null,
					metres: null,
					weight: null,
					assistance: null,
					unit: 'kg',
					rpe: null,
					missedReps: 0,
					isWarmup: false,
					isExtra: false
				}
			},
			fresh
		);
	});
	const state = applyLocal(
		strengthTable,
		replay(strengthTable, { workoutId: W, kit: KIT, canonical: null, pending: [start, ...sets] }),
		{ type: 'goTo', workoutId: W, position }
	);
	return viewOf(strengthTable, state)!;
}

const three = (p: number) => [p, p, p];

describe('targetWords', () => {
	it('names a new exercise’s first target with the sets that share it', () => {
		expect(targetWords(RDL!, 1)).toBe('3 × 8 at RPE 7');
		expect(targetWords(LEG_PRESS!, 2)).toBe('2 × 10 at RPE 7');
		expect(targetWords(PULL_UP!, 1)).toBe('3 × 6–10 at RPE 8');
		expect(targetWords(PLANK!, 1)).toBe('3 × 45 s');
	});

	it('a top set before its back-offs is one set; the back-offs carry their weight', () => {
		expect(targetWords(SQUAT!, 1)).toBe('5 reps at RPE 7');
		expect(targetWords(SQUAT!, 2)).toBe('3 × 5 at ≈ 100 kg');
	});

	it('one set alone, as a superset’s partner is named', () => {
		expect(targetWords(PLANK!, 1, true)).toBe('45 s');
		expect(targetWords(PULL_UP!, 2, true)).toBe('6–10 reps at RPE 8');
	});

	it('a long hold reads as minutes; no set is null', () => {
		expect(targetWords([{ ...PLANK![0]!, seconds: 90 }], 1)).toBe('1:30');
		expect(targetWords(PLANK!, 4)).toBeNull();
	});
});

describe('nextLine', () => {
	it('reads the label, the name and the target', () => {
		expect(nextLine({ position: 5, label: 'A2', name: 'Plank', target: '45 s' })).toBe(
			'Next: A2 Plank, 45 s'
		);
		expect(nextLine({ position: 6, label: null, name: 'Curl', target: null })).toBe('Next: Curl');
	});
});

describe('upNextWords', () => {
	it('names the next exercise from a straight one, and the partner inside a superset', () => {
		expect(upNextWords(view([], 2))).toEqual({
			position: 3,
			label: null,
			name: 'Romanian deadlift',
			target: '3 × 8 at RPE 7'
		});
		expect(upNextWords(view([], 4))).toMatchObject({ label: 'A2', name: 'Plank', target: '45 s' });
	});

	it('is null once every exercise is done', () => {
		const all = [1, 1, 1, 1, ...three(2), ...three(3), 4, 5, 4, 5, 4, 5];
		expect(upNextWords(view(all, 5))).toBeNull();
	});
});

describe('announcement', () => {
	it('after an exercise’s last set, Up next', () => {
		expect(announcement(view(three(2)), false)).toBe('Next: Romanian deadlift, 3 × 8 at RPE 7');
	});

	it('after a set the flow moved on from, the partner’s one set', () => {
		expect(announcement(view([4], 5), true)).toBe('Next: A2 Plank, 45 s');
	});

	it('nothing mid-exercise; every exercise done says so', () => {
		expect(announcement(view([2]), false)).toBeNull();
		const all = [1, 1, 1, 1, ...three(2), ...three(3), 4, 5, 4, 5, 4, 5];
		expect(announcement(view(all, 5), false)).toBe(ALL_DONE);
	});
});
