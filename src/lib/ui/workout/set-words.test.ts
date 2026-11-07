import { describe, expect, it } from 'vitest';
import { BASELINE_INSTRUCTION } from '#lib/domain/training/describe.ts';
import type { PlannedSet } from '#lib/domain/workout/selectors.ts';
import type { KitSet, LoggedSet } from '#lib/domain/workout/index.ts';
import { workoutDayKits } from '../../../../tests/fixtures/workout-day';
import {
	doneText,
	lastTimeText,
	LOAD_NOTE,
	loadLine,
	restText,
	setRows,
	targetText
} from './set-words';

const KIT = workoutDayKits({ date: '2026-11-06' }).strength;
const [SQUAT, LEG_PRESS, , PULL_UP, PLANK] = KIT.exercises.map((e) => e.sets) as KitSet[][];
const [TOP, BACK_OFF] = SQUAT!;

const logged = (over: Partial<LoggedSet & { isSkipped: boolean }> = {}) => ({
	id: `set-${Math.random()}`,
	reps: 5,
	seconds: null,
	metres: null,
	weight: 100,
	assistance: null,
	unit: 'kg' as const,
	rpe: 8,
	missedReps: 0,
	isWarmup: false,
	isExtra: false,
	isSkipped: false,
	...over
});

type Logged = ReturnType<typeof logged>;
const row = (setIndex: number, planned: KitSet | null, done: Logged | null = null) =>
	({ setIndex, planned, logged: done }) as unknown as PlannedSet;

describe('targetText', () => {
	it('names the amount, a computed load (≈ when estimated) and the RPE', () => {
		expect(targetText(TOP!)).toBe('5 reps · RPE 7');
		expect(targetText(BACK_OFF!)).toBe('5 reps · ≈ 100 kg');
		expect(targetText(PULL_UP![0]!)).toBe('6–10 reps · RPE 8');
		expect(targetText(PLANK![0]!)).toBe('0:45');
		expect(
			targetText({ ...BACK_OFF!, prescribedWeight: { value: 225, unit: 'lb', basis: 'absolute' } })
		).toBe('5 reps · 225 lb');
	});
});

describe('doneText', () => {
	it('reads each load type and measure as it was done', () => {
		expect(doneText(logged())).toBe('100 kg × 5 reps · RPE 8');
		expect(doneText(logged({ weight: null, reps: 8, rpe: null }))).toBe('8 reps');
		expect(doneText(logged({ weight: null, assistance: 20, rpe: null }))).toBe(
			'5 reps · 20 kg assist'
		);
		expect(doneText(logged({ weight: null, reps: null, seconds: 45, rpe: null }))).toBe('0:45');
		expect(doneText(logged({ weight: 227.5, unit: 'lb' }))).toBe('227.5 lb × 5 reps · RPE 8');
	});
});

describe('restText', () => {
	it('says the rest, no rest for 0, and nothing when none is given', () => {
		expect(restText(120)).toBe('Rest 2:00');
		expect(restText(0)).toBe('No rest');
		expect(restText(null)).toBeNull();
	});
});

describe('lastTimeText', () => {
	it("counts whole days back from the workout's day", () => {
		expect(lastTimeText('2026-10-30', '2026-11-06')).toBe('Last time · 7 days ago');
		expect(lastTimeText('2026-11-05', '2026-11-06')).toBe('Last time · yesterday');
		expect(lastTimeText('2026-11-06', '2026-11-06')).toBe('Last time · today');
		// Across the clock change at the end of October.
		expect(lastTimeText('2026-10-20', '2026-11-06')).toBe('Last time · 17 days ago');
		expect(lastTimeText('2026-10-20')).toBe('Last time');
	});
});

describe('loadLine', () => {
	it('gives the prescribed weight, never inventing one', () => {
		expect(loadLine(BACK_OFF!, 'external')).toEqual({ kind: 'weight', text: '≈ 100 kg' });
	});

	it('gives the baseline instruction when the weight is to be found', () => {
		expect(loadLine(TOP!, 'external')).toEqual({ kind: 'instruction', text: BASELINE_INSTRUCTION });
		// Before what the load type means: a baseline pull-up still asks for the RPE it reaches.
		expect(loadLine(TOP!, 'bodyweight')).toEqual({
			kind: 'instruction',
			text: BASELINE_INSTRUCTION
		});
	});

	it('says what a bodyweight or assisted load means, and nothing for an RPE-based external one', () => {
		expect(loadLine(PULL_UP![0]!, 'bodyweight')).toEqual({
			kind: 'note',
			text: LOAD_NOTE.bodyweight
		});
		expect(loadLine(PULL_UP![0]!, 'assisted')).toEqual({ kind: 'note', text: LOAD_NOTE.assisted });
		expect(loadLine(LEG_PRESS![0]!, 'external')).toBeNull();
		expect(loadLine(undefined, 'none')).toBeNull();
	});
});

describe('setRows', () => {
	it('marks the first planned set with nothing logged as current, the rest to do', () => {
		const rows = setRows([row(1, TOP!, logged()), row(2, BACK_OFF!), row(3, BACK_OFF!)]);
		expect(rows.map((r) => [r.setIndex, r.state, r.text])).toEqual([
			[1, 'done', '100 kg × 5 reps · RPE 8'],
			[2, 'current', '5 reps · ≈ 100 kg'],
			[3, 'todo', '5 reps · ≈ 100 kg']
		]);
	});

	it('names skipped, extra and missed sets', () => {
		const rows = setRows([
			row(1, TOP!, logged({ isSkipped: true })),
			row(2, BACK_OFF!, logged({ reps: 3, missedReps: 2 })),
			row(3, BACK_OFF!),
			row(4, BACK_OFF!),
			row(5, null, logged({ isExtra: true }))
		]);
		expect(rows.map((r) => r.state)).toEqual(['skipped', 'missed', 'current', 'todo', 'extra']);
		expect(rows.map((r) => r.word)).toEqual(['Skipped', '2 missed', 'Now', 'To do', 'Extra set']);
		// A skipped set keeps what it asked for.
		expect(rows[0]!.text).toBe('5 reps · RPE 7');
	});

	it('has no current set once the exercise has ended, or when every set is done', () => {
		expect(setRows([row(1, TOP!), row(2, BACK_OFF!)], true).map((r) => r.state)).toEqual([
			'todo',
			'todo'
		]);
		expect(setRows([row(1, TOP!, logged())]).map((r) => r.state)).toEqual(['done']);
	});
});
