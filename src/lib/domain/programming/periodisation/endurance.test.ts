import { describe, expect, it } from 'vitest';
import { staticRuleKeys } from '../../../../../scripts/rule-keys';
import { addDays } from '../../calendar';
import type { IsoDate } from '../../calendar';
import { periodisedWeekTargetsSchema } from '../../training/schemas';
import { paceFor, trainingPaces } from '../paces';
import { ENDURANCE, HALF_HOOKS, hooksFor } from '../rules/endurance';
import type { EnduranceEvent } from '../rules/endurance';
import { RULE_BY_ID } from '../rules/registry/index';
import { ASSUMED_EASY_PACE, MARATHON_HOOKS } from '../rules/running';
import { TAPERS } from '../rules/taper';
import { enduranceWeeks } from './endurance';
import type { EnduranceInput, EnduranceWeek } from './endurance';
import { BLOCK_PHASES, BLOCK_WEEK_KINDS } from './kinds';

const MONDAY = '2026-01-05';
/** The Sunday of the `n`th week from MONDAY, counting MONDAY's week as 1. */
const sundayOf = (n: number): IsoDate => addDays(MONDAY, 7 * n - 1);
const input = (over: Partial<EnduranceInput> = {}): EnduranceInput => ({
	startsOn: MONDAY,
	raceOn: sundayOf(18),
	startVolume: 40_000,
	longestRun: 16_000,
	level: null,
	...over
});
const down100 = (n: number) => Math.floor(n / 100) * 100;
const roles = (weeks: EnduranceWeek[]) => weeks.map((w) => w.phase.split('_')[1]);
const count = (weeks: EnduranceWeek[], role: string) =>
	roles(weeks).filter((r) => r === role).length;

/** Many blocks: both events, every runway they allow, small and big runners, with and without a recent level. */
const BLOCKS = (['marathon', 'half'] as const).flatMap((event) => {
	const runways = event === 'marathon' ? [8, 10, 12, 14, 16, 18, 20] : [6, 8, 10, 12, 14];
	return runways.flatMap((n) =>
		[
			{ startVolume: 20_000, longestRun: null, level: null },
			{ startVolume: 45_000, longestRun: 14_000, level: { metres: 70_000, weeksAgo: 2 } },
			{ startVolume: 70_000, longestRun: 28_000, level: null }
		].map((runner) => {
			const given = input({ ...runner, raceOn: sundayOf(n) });
			return { event, n, given, weeks: enduranceWeeks(event, given) };
		})
	);
});

describe('marathon and half blocks', () => {
	it('never grows a week more than 10 % over the biggest before it, unless regaining a recent level', () => {
		let regained = 0;
		for (const { given, weeks } of BLOCKS) {
			let biggest = given.startVolume;
			weeks.forEach((week, i) => {
				const share = week.volumeMetres / biggest - 1;
				if (week.change.ruleKey === 'endurance.regain') {
					regained++;
					expect(share).toBeLessThanOrEqual(ENDURANCE.regain.max + 1e-9);
					expect(week.volumeMetres).toBeLessThanOrEqual(given.level!.metres);
					expect(given.level!.weeksAgo + i).toBeLessThanOrEqual(ENDURANCE.regain.withinWeeks);
				} else expect(share).toBeLessThanOrEqual(0.1 + 1e-9);
				expect(week.change.share).toBeCloseTo(share, 2);
				expect(week.targets.runVolumeFactor).toBeLessThanOrEqual(ENDURANCE.ceiling.maxFactor);
				biggest = Math.max(biggest, week.volumeMetres);
			});
		}
		expect(regained).toBeGreaterThan(0);
	});

	it('regains a level held in the last 8 weeks at up to 20 %, and says so', () => {
		const weeks = enduranceWeeks('marathon', input({ level: { metres: 60_000, weeksAgo: 3 } }));
		expect(weeks.slice(0, 3).map((w) => [w.volumeMetres, w.change])).toEqual([
			[40_000, { share: 0, ruleKey: 'endurance.increase' }],
			[48_000, { share: 0.2, ruleKey: 'endurance.regain' }],
			[57_600, { share: 0.2, ruleKey: 'endurance.regain' }]
		]);
		// A level held too long ago is rebuilt at 10 %.
		const old = enduranceWeeks('marathon', input({ level: { metres: 60_000, weeksAgo: 8 } }));
		expect(old.some((w) => w.change.ruleKey === 'endurance.regain')).toBe(false);
		expect(old[1]!.volumeMetres).toBe(44_000);
	});

	it('makes every 4th week of base and build a cutback at 80 % of the biggest week, and never a peak or taper week', () => {
		for (const { weeks } of BLOCKS) {
			let biggest = 0;
			weeks.forEach((week, i) => {
				const role = roles(weeks)[i]!;
				const cutback = (role === 'base' || role === 'build') && (i + 1) % 4 === 0;
				expect(week.kind === 'cutback', `${week.startsOn} ${role}`).toBe(cutback);
				expect(week.targets.running.cutback).toBe(cutback);
				if (cutback) {
					expect(week.volumeMetres).toBe(down100(biggest * ENDURANCE.cutback.factor));
					expect(week.change.ruleKey).toBe('endurance.cutback');
				}
				biggest = Math.max(biggest, week.volumeMetres);
			});
		}
		expect(enduranceWeeks('marathon', input()).map((w) => w.kind)).toEqual([
			...['base', 'base', 'base', 'cutback'],
			...['build', 'build', 'build', 'cutback', 'build', 'build', 'build', 'cutback'],
			...['peak', 'peak', 'peak', 'taper', 'taper', 'event']
		]);
	});

	it('grows the long run at most 1.5 km a week, within its share of the week and its caps', () => {
		for (const { event, given, weeks } of BLOCKS) {
			let longest = given.longestRun ?? Infinity;
			for (const week of weeks) {
				const long = week.targets.running.longRunMetres;
				if (week.kind === 'event') {
					expect(long).toBeNull();
					continue;
				}
				expect(long).not.toBeNull();
				expect(long!).toBeLessThanOrEqual(longest + ENDURANCE.long_run.stepMetres);
				expect(long!).toBeLessThanOrEqual(
					hooksFor(week.phase)!.longRunShareMax! * week.volumeMetres
				);
				expect(long!).toBeLessThanOrEqual(event === 'marathon' ? 32_000 : 22_000);
				longest = longest === Infinity ? long! : Math.max(longest, long!);
			}
		}
		// A fast, big runner reaches 32 km in a marathon's peak, at up to 35 % of the week…
		const big = { startVolume: 70_000, longestRun: 28_000 };
		const fast = enduranceWeeks('marathon', input({ ...big, paces: trainingPaces(60) }));
		expect(Math.max(...fast.map((w) => w.targets.running.longRunMetres ?? 0))).toBe(32_000);
		// …with no paces known, three hours at M3's assumed easy pace caps it…
		const unpaced = enduranceWeeks('marathon', input(big));
		expect(Math.max(...unpaced.map((w) => w.targets.running.longRunMetres ?? 0))).toBe(
			down100((180 * 60 * 1000) / ASSUMED_EASY_PACE)
		);
		// …but no more than three hours at a slow long-run pace.
		const paces = trainingPaces(35);
		const slow = paceFor('long', paces)[1];
		const timed = enduranceWeeks(
			'marathon',
			input({ startVolume: 70_000, longestRun: 28_000, paces })
		);
		const top = Math.max(...timed.map((w) => w.targets.running.longRunMetres ?? 0));
		expect(top).toBe(down100((180 * 60 * 1000) / slow));
		expect(top).toBeLessThan(32_000);
	});

	it('tapers a marathon 80/60/40 and a half 70/50 of the peak, the last taper week being race week', () => {
		const marathon = enduranceWeeks('marathon', input());
		const peak = marathon.find((w) => w.kind === 'peak')!.volumeMetres;
		const last3 = marathon.slice(-3);
		expect(last3.map((w) => w.kind)).toEqual(['taper', 'taper', 'event']);
		expect(last3.map((w) => w.volumeMetres)).toEqual(
			TAPERS.marathon.factors.map((f) => down100(peak * f))
		);
		expect(TAPERS.marathon.factors).toEqual([0.8, 0.6, 0.4]);
		expect(last3.map((w) => w.targets.volumeFactor)).toEqual([0.8, 0.6, 0.4]);
		expect(last3.every((w) => w.change.ruleKey === 'taper.marathon')).toBe(true);

		const half = enduranceWeeks('half', input({ raceOn: sundayOf(12) }));
		const halfPeak = half.find((w) => w.kind === 'peak')!.volumeMetres;
		expect(half.slice(-2).map((w) => [w.kind, w.volumeMetres])).toEqual([
			['taper', down100(halfPeak * 0.7)],
			['event', down100(halfPeak * 0.5)]
		]);
	});

	it('adds a race week after the taper for a race early in the week', () => {
		const wednesday = addDays(sundayOf(18), -4);
		const weeks = enduranceWeeks('marathon', input({ raceOn: wednesday }));
		expect(weeks).toHaveLength(18);
		expect(weeks.slice(-4).map((w) => [w.kind, w.targets.volumeFactor])).toEqual([
			['taper', 0.8],
			['taper', 0.6],
			['taper', 0.4],
			['event', 0.4]
		]);
		expect(count(weeks, 'peak')).toBe(3);
	});

	it('puts race-specific work in every build and peak week, marathon pace as a steady segment at M pace', () => {
		for (const { event, weeks } of BLOCKS) {
			for (const week of weeks) {
				const role = week.phase.split('_')[1]!;
				if (role !== 'build' && role !== 'peak') continue;
				expect(week.raceWork.map((w) => w.work)).toEqual(ENDURANCE.race_work[event][role]);
				expect(week.targets.running.raceSpecific).toBe(week.raceWork[0]!.work);
				expect(week.quality).toBe(2);
			}
			expect(weeks.filter((w) => w.phase.endsWith('_base')).every((w) => !w.raceWork.length)).toBe(
				true
			);
		}
		const paces = trainingPaces(50);
		const weeks = enduranceWeeks('marathon', input({ paces }));
		const builds = weeks.filter((w) => w.phase === 'marathon_build');
		const shares = builds.map((w) => {
			const mp = w.raceWork.find((r) => r.work === 'marathon_pace')!;
			expect(mp.label).toBe('at marathon pace');
			expect(mp.segment).toMatchObject({
				kind: 'steady',
				hrZone: 3,
				targetRpe: ENDURANCE.marathon_pace.rpe,
				paceMinSecondsPerKm: paces.M[0],
				paceMaxSecondsPerKm: paces.M[1]
			});
			return mp.segment.distanceMetres! / w.targets.running.longRunMetres!;
		});
		expect(shares[0]).toBeCloseTo(0.2, 1);
		expect(shares.at(-1)).toBeCloseTo(0.4, 1);
		for (const share of shares) expect(share).toBeLessThanOrEqual(0.4);
		const peakMp = weeks.find((w) => w.kind === 'peak')!.raceWork[0]!;
		expect(peakMp.segment.distanceMetres).toBeGreaterThan(0);

		// A half's intervals run at 10K pace, between threshold and VO2max.
		const half = enduranceWeeks('half', input({ raceOn: sundayOf(12), paces }));
		const intervals = half.find((w) => w.kind === 'peak')!.raceWork[0]!;
		expect(intervals).toMatchObject({ work: 'intervals', label: 'at 10K pace' });
		expect(intervals.segment).toMatchObject({
			kind: 'interval',
			distanceMetres: null,
			paceMinSecondsPerKm: paces.I[1],
			paceMaxSecondsPerKm: paces.T[0]
		});
	});
});

describe('half blocks and their hooks', () => {
	it('plans a half in half_* phases only, with its own hooks', () => {
		for (const { event, weeks } of BLOCKS) {
			const other = event === 'half' ? 'marathon_' : 'half_';
			expect(
				weeks.every((w) => w.phase.startsWith(`${event}_`) && !w.phase.startsWith(other))
			).toBe(true);
			for (const week of weeks) {
				if (week.kind !== 'event') expect(week.quality).toBe(hooksFor(week.phase)!.qualityPerWeek);
			}
		}
	});

	it('reads M3’s marathon hooks live for marathon phases and HALF_HOOKS for half phases', () => {
		expect(hooksFor('half_build')?.qualityPerWeek).toBe(2);
		for (const phase of BLOCK_PHASES.marathon) expect(hooksFor(phase)).toBe(MARATHON_HOOKS[phase]);
		for (const phase of BLOCK_PHASES.half) expect(hooksFor(phase)).toBe(HALF_HOOKS[phase]);
		expect(HALF_HOOKS).toEqual({
			half_base: { runWeeklyIncreaseMax: 0.1, qualityPerWeek: 1, longRunShareMax: 0.3 },
			half_build: { runWeeklyIncreaseMax: 0.1, qualityPerWeek: 2, longRunShareMax: 0.3 },
			half_peak: { runWeeklyIncreaseMax: 0, qualityPerWeek: 2, longRunShareMax: 0.3 },
			half_taper: { runVolumeFactor: 0.6, qualityPerWeek: 1, longRunShareMax: 0.3 }
		});
		expect(hooksFor('accumulation')).toBeUndefined();
		expect(hooksFor('maintenance')).toBeUndefined();
	});

	it('compresses the base for a 10-week runway and keeps the peak and taper', () => {
		const marathon = enduranceWeeks('marathon', input({ raceOn: sundayOf(10) }));
		expect(['base', 'build', 'peak', 'taper'].map((r) => count(marathon, r))).toEqual([0, 4, 3, 3]);
		const half = enduranceWeeks('half', input({ raceOn: sundayOf(10) }));
		expect(['base', 'build', 'peak', 'taper'].map((r) => count(half, r))).toEqual([2, 4, 2, 2]);
		// The full runway: 4–6 base and 6–8 build for a marathon, 3–4 and 4–6 for a half.
		const full = enduranceWeeks('marathon', input({ raceOn: sundayOf(20) }));
		expect(['base', 'build', 'peak', 'taper'].map((r) => count(full, r))).toEqual([6, 8, 3, 3]);
		expect(() => enduranceWeeks('marathon', input({ raceOn: sundayOf(21) }))).toThrow(RangeError);
		expect(() => enduranceWeeks('half', input({ raceOn: sundayOf(15) }))).toThrow(RangeError);
		expect(() => enduranceWeeks('marathon', input({ raceOn: sundayOf(5) }))).toThrow(RangeError);
		expect(() => enduranceWeeks('half', input({ startVolume: 0 }))).toThrow(RangeError);
	});

	it('holds strength at maintenance in peak and taper, with no heavy lower body in the last 5 days', () => {
		for (const { given, weeks } of BLOCKS) {
			for (const week of weeks) {
				const late = /_(peak|taper)$/.test(week.phase);
				expect(week.targets.maintenance, week.phase).toEqual(late ? ['strength'] : undefined);
			}
			const from = addDays(given.raceOn, -ENDURANCE.strength.noHeavyLowerDays);
			expect(weeks.filter((w) => w.noHeavyLowerFrom).map((w) => w.noHeavyLowerFrom)).toEqual([
				from
			]);
		}
		const wednesday = enduranceWeeks('half', input({ raceOn: addDays(sundayOf(12), -4) }));
		expect(wednesday.flatMap((w) => w.noHeavyLowerFrom ?? [])).toEqual([
			addDays(sundayOf(12), -9),
			addDays(sundayOf(11), 1)
		]);
	});

	it('gives every week a kind from BLOCK_WEEK_KINDS, in phase order, with targets the plan schema stores', () => {
		for (const { event, weeks } of BLOCKS) {
			const kinds: readonly string[] = Object.values(BLOCK_WEEK_KINDS[event]);
			const phases: readonly string[] = BLOCK_PHASES[event];
			const order = weeks.map((w) => phases.indexOf(w.phase));
			expect(order).toEqual([...order].sort((a, b) => a - b));
			weeks.forEach((week, i) => {
				expect(kinds).toContain(week.kind);
				expect(week.startsOn).toBe(addDays(MONDAY, 7 * i));
				expect(periodisedWeekTargetsSchema.safeParse(week.targets).success, week.startsOn).toBe(
					true
				);
			});
			expect(weeks.at(-1)!.kind).toBe(BLOCK_WEEK_KINDS[event].race);
		}
	});

	it('is deterministic, and starts on the Monday of a mid-week start', () => {
		const given = input({ level: { metres: 55_000, weeksAgo: 1 } });
		expect(enduranceWeeks('marathon', given)).toEqual(
			enduranceWeeks('marathon', structuredClone(given))
		);
		const thursday = enduranceWeeks('marathon', input({ startsOn: addDays(MONDAY, 3) }));
		expect(thursday).toEqual(enduranceWeeks('marathon', input()));
	});

	it.each(['marathon', 'half'] satisfies EnduranceEvent[])(
		'%s: every rule key a week cites is registered',
		(event) => {
			const cited = [
				...new Set([
					...BLOCKS.filter((b) => b.event === event).flatMap((b) =>
						b.weeks.map((w) => w.change.ruleKey)
					),
					...staticRuleKeys(['src/lib/domain/programming/periodisation/endurance.ts'])
				])
			];
			for (const key of cited)
				expect(RULE_BY_ID.get(key)?.area, key).toMatch(/^(endurance|taper)$/);
			expect(cited).toEqual(expect.arrayContaining(['endurance.increase', 'endurance.cutback']));
		}
	);
});
