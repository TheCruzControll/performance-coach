import { describe, expect, it } from 'vitest';
import { EXPERIENCE_LEVELS } from '../../profile/catalog';
import { percentOfOneRepMax } from '../../rpe';
import { periodisedWeekTargetsSchema, PRESCRIPTION_LIMITS } from '../../training/schemas';
import { OPENERS } from '../rules/strength-phases';
import { BLOCK_WEEK_KINDS } from './kinds';
import { meetSequence, strengthWeeks } from './strength';
import type { StrengthWeek } from './strength';

const kinds = (weeks: StrengthWeek[]) => weeks.map((week) => week.kind);
const runs = (weeks: StrengthWeek[]) => {
	const out: [string, number][] = [];
	for (const { kind } of weeks) {
		const last = out.at(-1);
		if (last?.[0] === kind) last[1] += 1;
		else out.push([kind, 1]);
	}
	return out;
};
const lifts = (weeks: StrengthWeek[]) => weeks.map((week) => week.targets.mainLifts);
const SEQUENCES = EXPERIENCE_LEVELS.flatMap((level) =>
	[0, 1, 2, 4, 6, 7, 10, 12, 16].map((weeks) => meetSequence(weeks, level))
);

describe('strength phases', () => {
	it('lowers reps and raises RPE from accumulation to realization, while volume falls', () => {
		const [acc, int, real] = (['accumulation', 'intensification', 'realization'] as const).map(
			(phase) => lifts(strengthWeeks(phase, 3, 'advanced'))
		);
		expect(acc).toEqual([
			{ repsMin: 6, repsMax: 8, topRpe: 7, setsFactor: 1 },
			{ repsMin: 6, repsMax: 8, topRpe: 7.5, setsFactor: 1.08 },
			{ repsMin: 6, repsMax: 8, topRpe: 8, setsFactor: 1.15 }
		]);
		expect(int!.map((w) => [w.repsMin, w.repsMax, w.topRpe, w.setsFactor])).toEqual([
			[3, 5, 8, 0.85],
			[3, 5, 8.5, 0.83],
			[3, 5, 9, 0.8]
		]);
		expect(real!.map((w) => [w.repsMin, w.repsMax, w.topRpe, w.setsFactor])).toEqual([
			[1, 3, 8.5, 0.6],
			[1, 3, 9, 0.55],
			[1, 3, 9.5, 0.5]
		]);
		for (const [earlier, later] of [
			[acc!, int!],
			[int!, real!]
		] as const) {
			expect(later[0]!.repsMax).toBeLessThan(earlier[0]!.repsMax);
			expect(later[0]!.repsMin).toBeLessThan(earlier[0]!.repsMin);
			expect(later[0]!.topRpe).toBeGreaterThan(earlier[0]!.topRpe);
			expect(later.at(-1)!.topRpe).toBeGreaterThan(earlier.at(-1)!.topRpe);
			expect(Math.max(...later.map((w) => w.setsFactor))).toBeLessThan(
				Math.min(...earlier.map((w) => w.setsFactor))
			);
		}
	});

	it('caps the week at its top set, and keeps the main-lift volume as its volume factor', () => {
		for (const week of SEQUENCES.flat()) {
			expect(week.targets.rpeCap).toBe(week.targets.mainLifts.topRpe);
			expect(week.targets.volumeFactor).toBe(week.targets.mainLifts.setsFactor);
		}
	});

	it('never goes above RPE 9.5, and keeps reps, RPE, loads and load steps within the limits', () => {
		const [rpeLow, rpeHigh] = PRESCRIPTION_LIMITS.rpe;
		const [repsLow, repsHigh] = PRESCRIPTION_LIMITS.reps;
		const [shareLow, shareHigh] = PRESCRIPTION_LIMITS.loadFraction;
		const all = SEQUENCES.flat();
		expect(Math.max(...all.map((w) => w.targets.rpeCap))).toBe(9.5);
		for (const { targets } of all) {
			const { repsMin, repsMax, topRpe } = targets.mainLifts;
			expect(topRpe).toBeGreaterThanOrEqual(rpeLow);
			expect(topRpe).toBeLessThanOrEqual(Math.min(9.5, rpeHigh));
			expect(repsMin).toBeGreaterThanOrEqual(repsLow);
			expect(repsMax).toBeLessThanOrEqual(repsHigh);
			for (const reps of [repsMin, repsMax]) {
				const share = percentOfOneRepMax(reps, topRpe);
				expect(share).not.toBeNull();
				expect(share).toBeGreaterThanOrEqual(shareLow);
				expect(share).toBeLessThanOrEqual(shareHigh);
			}
			expect(targets.loadStep).toBeGreaterThanOrEqual(0);
			expect(targets.loadStep).toBeLessThanOrEqual(0.025);
		}
		expect(OPENERS.e1rmShare).toBeGreaterThanOrEqual(shareLow);
		expect(OPENERS.e1rmShare).toBeLessThanOrEqual(shareHigh);
	});

	it('peaks for a meet 10, 16 and 6 weeks away, each ending in its taper and then the meet', () => {
		expect(runs(meetSequence(10, 'intermediate'))).toEqual([
			['accumulation', 4],
			['intensification', 3],
			['peak', 2],
			['taper', 1],
			['event', 1]
		]);
		expect(runs(meetSequence(16, 'intermediate'))).toEqual([
			['accumulation', 7],
			['intensification', 6],
			['peak', 2],
			['taper', 1],
			['event', 1]
		]);
		expect(runs(meetSequence(6, 'advanced'))).toEqual([
			['accumulation', 1],
			['intensification', 2],
			['peak', 2],
			['taper', 1],
			['event', 1]
		]);
		expect(runs(meetSequence(12, 'advanced')).map(([, n]) => n)).toEqual([5, 4, 2, 1, 1]);
		expect(runs(meetSequence(11, 'advanced')).map(([, n]) => n)).toEqual([5, 3, 2, 1, 1]);
		expect(runs(meetSequence(9, 'advanced')).map(([, n]) => n)).toEqual([3, 3, 2, 1, 1]);
		expect(runs(meetSequence(8, 'advanced')).map(([, n]) => n)).toEqual([3, 2, 2, 1, 1]);
		expect(runs(meetSequence(7, 'advanced')).map(([, n]) => n)).toEqual([2, 2, 2, 1, 1]);
	});

	it('compresses a short run-up, always keeping the taper before the meet', () => {
		expect(kinds(meetSequence(4, 'advanced'))).toEqual([
			'accumulation',
			'intensification',
			'peak',
			'taper',
			'event'
		]);
		expect(kinds(meetSequence(2, 'advanced'))).toEqual(['peak', 'taper', 'event']);
		expect(kinds(meetSequence(1, 'advanced'))).toEqual(['taper', 'event']);
		expect(kinds(meetSequence(0, 'advanced'))).toEqual(['event']);
		for (const level of EXPERIENCE_LEVELS) {
			for (const weeks of [1, 2, 3, 5, 6, 7, 9, 10, 11, 16, 20]) {
				const sequence = meetSequence(weeks, level);
				expect(sequence, `${level} ${weeks}`).toHaveLength(weeks + 1);
				expect(kinds(sequence).slice(-2), `${level} ${weeks}`).toEqual(['taper', 'event']);
			}
		}
	});

	it('gives new and novice lifters no realization, planning those weeks as intensification', () => {
		for (const level of ['new', 'novice'] as const) {
			expect(runs(meetSequence(10, level))).toEqual([
				['accumulation', 4],
				['intensification', 5],
				['taper', 1],
				['event', 1]
			]);
			expect(kinds(meetSequence(2, level))).toEqual(['intensification', 'taper', 'event']);
			const weeks = strengthWeeks('realization', 2, level);
			expect(weeks.map((w) => [w.kind, w.phase])).toEqual([
				['intensification', 'intensification'],
				['intensification', 'intensification']
			]);
			expect(Math.max(...meetSequence(16, level).map((w) => w.targets.rpeCap))).toBe(9);
		}
		expect(kinds(strengthWeeks('realization', 2, 'intermediate'))).toEqual(['peak', 'peak']);
	});

	it('takes each week’s kind from BLOCK_WEEK_KINDS: realization weeks are peak, the meet’s week is event', () => {
		const sequence = meetSequence(10, 'advanced');
		const S = BLOCK_WEEK_KINDS.strength;
		expect(sequence.map((w) => [w.phase, w.kind])).toEqual([
			...Array(4).fill(['accumulation', S.accumulation]),
			...Array(3).fill(['intensification', S.intensification]),
			['realization', 'peak'],
			['realization', S.realization],
			['taper', S.meet_taper],
			['taper', S.meet]
		]);
		expect(sequence.at(-1)!.targets).toEqual({
			rpeCap: 7,
			volumeFactor: 0.4,
			loadStep: 0,
			runVolumeFactor: 0.4,
			mainLifts: { repsMin: 1, repsMax: 1, topRpe: 7, setsFactor: 0.4 }
		});
		expect(sequence.at(-2)!.targets).toEqual({
			rpeCap: 8,
			volumeFactor: 0.5,
			loadStep: 0,
			runVolumeFactor: 0.6,
			mainLifts: { repsMin: 1, repsMax: 2, topRpe: 8, setsFactor: 0.5 }
		});
	});

	it('validates every week against the WeekTargets schema, and is deterministic', () => {
		for (const { targets } of SEQUENCES.flat()) {
			const parsed = periodisedWeekTargetsSchema.safeParse(targets);
			expect(parsed.success, JSON.stringify(targets)).toBe(true);
			expect(parsed.data).toEqual(targets);
		}
		const first = meetSequence(16, 'intermediate');
		expect(meetSequence(16, 'intermediate')).toEqual(first);
		first[0]!.targets.mainLifts.topRpe = 10;
		expect(meetSequence(16, 'intermediate')[0]!.targets.mainLifts.topRpe).toBe(7);
		expect(strengthWeeks('accumulation', 1, 'advanced')[0]!.targets.rpeCap).toBe(7);
		expect(strengthWeeks('taper', 0, 'advanced')).toEqual([]);
	});

	it('refuses a negative or fractional number of weeks', () => {
		expect(() => meetSequence(-1, 'advanced')).toThrow(RangeError);
		expect(() => meetSequence(2.5, 'advanced')).toThrow('whole number of weeks');
		expect(() => strengthWeeks('accumulation', -2, 'advanced')).toThrow(RangeError);
	});
});
