import { describe, expect, it } from 'vitest';
import { estimateOneRepMax } from '#lib/domain/e1rm.ts';
import { SCHEMAS, validate } from '#lib/domain/profile/schemas.ts';
import type { StrengthBaseline } from '#lib/domain/profile/types.ts';
import {
	baselinesDraft,
	baselinesPayload,
	baselineSummary,
	liftDraft,
	liftName,
	liveEstimate,
	newLift,
	suggestedLifts,
	trim,
	type LiftDraft
} from './strength';

const at = new Date('2026-11-01T08:00:00Z');

const squat: StrengthBaseline = {
	id: '3f0c2b1e-6a4d-4c1e-9a52-1d9e6b0f7a11',
	lift: 'back_squat',
	customLabel: null,
	kind: 'measured',
	source: 'tested',
	value: 140,
	unit: 'kg',
	achievedOn: '2026-10-12',
	setWeight: null,
	setReps: null,
	setRpe: null,
	method: null,
	confidence: null,
	notes: null,
	recordedAt: at
};

const bench: StrengthBaseline = {
	id: '9b7d4c2a-1e3f-4a5b-8c6d-7e8f9a0b1c22',
	lift: 'bench_press',
	customLabel: null,
	kind: 'estimated',
	source: 'set',
	value: 123.3,
	unit: 'kg',
	achievedOn: null,
	setWeight: 100,
	setReps: 5,
	setRpe: 8,
	method: 'rpe-table',
	confidence: 'medium',
	notes: null,
	recordedAt: at
};

describe('baselinesPayload', () => {
	it('sends no lifts for “I don’t know my 1RMs”, even with lifts still in the editor', () => {
		const draft = { unknown: true, lifts: [liftDraft(squat), liftDraft(bench)] };
		expect(baselinesPayload(draft)).toEqual({ unknown: true, lifts: [] });
		expect(draft.lifts).toHaveLength(2);
	});

	it('sends each lift in place, without its row key, with only the fields its source uses', () => {
		const bestGuess: LiftDraft = {
			...newLift('deadlift', 'kg'),
			source: 'estimate',
			value: 200,
			// Typed while the source was "From a recent set", then hidden by the switch.
			setWeight: 150,
			setReps: 25,
			setRpe: 4
		};
		const fromSet: LiftDraft = { ...liftDraft(bench), value: 140 };
		expect(baselinesPayload({ unknown: false, lifts: [bestGuess, fromSet] })).toEqual({
			unknown: false,
			lifts: [
				{
					lift: 'deadlift',
					customLabel: null,
					source: 'estimate',
					value: 200,
					unit: 'kg',
					achievedOn: null,
					setWeight: null,
					setReps: null,
					setRpe: null,
					notes: null
				},
				{
					lift: 'bench_press',
					customLabel: null,
					source: 'set',
					value: null,
					unit: 'kg',
					achievedOn: null,
					setWeight: 100,
					setReps: 5,
					setRpe: 8,
					notes: null
				}
			]
		});
		// A hidden field never fails: the set fields above are out of range, the value is not.
		expect(
			validate(SCHEMAS.baselines, baselinesPayload({ unknown: false, lifts: [bestGuess] }))
		).toMatchObject({ ok: true });
	});

	it('saves what was loaded straight back, and a lift with no source fails on that row', () => {
		const draft = baselinesDraft({ unknown: false, lifts: [squat, bench] });
		expect(validate(SCHEMAS.baselines, baselinesPayload(draft)).ok).toBe(true);

		draft.lifts.splice(1, 0, newLift('deadlift', 'kg'));
		expect(validate(SCHEMAS.baselines, baselinesPayload(draft))).toEqual({
			ok: false,
			errors: { 'lifts.1.source': 'How do you know this number?' }
		});
	});
});

describe('liftDraft and baselinesDraft', () => {
	it('edits a measured max as it was saved, keyed by its stored id', () => {
		expect(liftDraft(squat)).toEqual({
			key: squat.id,
			lift: 'back_squat',
			customLabel: null,
			source: 'tested',
			value: 140,
			unit: 'kg',
			achievedOn: '2026-10-12',
			setWeight: null,
			setReps: null,
			setRpe: null,
			notes: null
		});
	});

	it('hides the computed value of a set-based lift: the set is what the owner edits', () => {
		expect(liftDraft(bench)).toMatchObject({
			source: 'set',
			value: null,
			setWeight: 100,
			setReps: 5,
			setRpe: 8
		});
		expect(liftDraft({ ...bench, source: 'estimate', kind: 'estimated' }).value).toBe(123.3);
	});

	it('keeps “I don’t know” and the lifts in their saved order', () => {
		expect(baselinesDraft({ unknown: true, lifts: [] })).toEqual({ unknown: true, lifts: [] });
		expect(
			baselinesDraft({ unknown: false, lifts: [squat, bench] }).lifts.map((l) => l.key)
		).toEqual([squat.id, bench.id]);
	});
});

describe('newLift', () => {
	it('starts blank in the owner’s unit, with no source until the owner picks one', () => {
		expect(newLift('snatch', 'lb')).toMatchObject({
			lift: 'snatch',
			customLabel: null,
			source: null,
			value: null,
			unit: 'lb',
			achievedOn: null,
			setWeight: null,
			setReps: null,
			setRpe: null,
			notes: null
		});
	});

	it('gives every row its own key, also two of the same lift', () => {
		const keys = [newLift('custom', 'kg'), newLift('custom', 'kg'), newLift('deadlift', 'kg')].map(
			(l) => l.key
		);
		expect(new Set(keys).size).toBe(3);
		expect(keys).not.toContain(squat.id);
	});
});

describe('suggestedLifts', () => {
	it('offers each discipline’s lifts once, in the order the disciplines come', () => {
		expect(suggestedLifts(['powerlifting'])).toEqual(['back_squat', 'bench_press', 'deadlift']);
		expect(suggestedLifts(['weightlifting', 'powerlifting'])).toEqual([
			'snatch',
			'clean_and_jerk',
			'front_squat',
			'back_squat',
			'bench_press',
			'deadlift'
		]);
		expect(suggestedLifts(['running', 'muay_thai'])).toEqual(['back_squat', 'deadlift']);
	});

	it('falls back to squat, bench and deadlift when no discipline has lifts to suggest', () => {
		expect(suggestedLifts([])).toEqual(['back_squat', 'bench_press', 'deadlift']);
		expect(suggestedLifts(['running', 'custom'])).toEqual([
			'back_squat',
			'bench_press',
			'deadlift'
		]);
	});
});

describe('liftName', () => {
	it('names a lift of the owner’s own by what they typed, and the rest by their label', () => {
		expect(liftName({ lift: 'custom', customLabel: 'Zercher squat' })).toBe('Zercher squat');
		expect(liftName({ lift: 'custom', customLabel: '  ' })).toBe('Other lift');
		expect(liftName({ lift: 'custom', customLabel: null })).toBe('Other lift');
		expect(liftName({ lift: 'clean_and_jerk', customLabel: null })).toBe('Clean & jerk');
	});
});

describe('liveEstimate', () => {
	it('is the shared e1RM of the set, so the screen shows what the server stores', () => {
		const lift = liftDraft(bench);
		expect(liveEstimate(lift)).toEqual(estimateOneRepMax({ weight: 100, reps: 5, rpe: 8 }));
		expect(liveEstimate({ ...lift, setRpe: null })).toEqual(
			estimateOneRepMax({ weight: 100, reps: 5 })
		);
	});

	it('is nothing until the set has a weight and reps, and never for a max typed in', () => {
		expect(liveEstimate({ ...liftDraft(bench), setReps: null })).toBeNull();
		expect(liveEstimate({ ...liftDraft(bench), setWeight: null })).toBeNull();
		expect(liveEstimate({ ...liftDraft(bench), setRpe: 5 })).toBeNull();
		expect(liveEstimate({ ...liftDraft(bench), source: 'tested', value: 130 })).toBeNull();
	});
});

describe('baselineSummary', () => {
	it('marks an estimate with ≈ and says what it came from', () => {
		expect(baselineSummary(bench)).toBe('≈ 123.3 kg · Estimated, from 100 × 5 @ RPE 8');
		expect(baselineSummary({ ...bench, setRpe: null })).toBe(
			'≈ 123.3 kg · Estimated, from 100 × 5'
		);
		expect(
			baselineSummary({ ...bench, source: 'estimate', value: 125, setWeight: null, setReps: null })
		).toBe('≈ 125 kg · Estimated, my best guess');
	});

	it('gives a measured max as it was lifted', () => {
		expect(baselineSummary(squat)).toBe('140 kg · Measured, tested max');
		expect(baselineSummary({ ...squat, source: 'competition', value: 317.5, unit: 'lb' })).toBe(
			'317.5 lb · Measured, competition lift'
		);
	});
});

describe('trim', () => {
	it('writes a weight with at most two decimals and no trailing zeros', () => {
		expect(trim(82.5)).toBe('82.5');
		expect(trim(140)).toBe('140');
		expect(trim(100 / 0.811)).toBe('123.3');
		expect(trim(102.456)).toBe('102.46');
	});
});
