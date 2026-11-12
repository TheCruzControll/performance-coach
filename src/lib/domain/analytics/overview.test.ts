import { describe, expect, it } from 'vitest';
import { addDays } from '../calendar';
import { METRICS } from './metrics';
import type { MetricId } from './metrics';
import {
	disciplineVerdict,
	goodness,
	headline,
	kpi,
	soFarLine,
	trendOf,
	VERDICT_WORDS
} from './overview';
import type { DisciplineVerdict, Evidence } from './overview';
import { periodWindow, PERIODS, weekStarts } from './periods';
import type { Period } from './periods';
import { byMonth, byWeek, fillWeeks, soFar } from './series';
import type { Timed } from './series';
import type { SeriesPoint } from './types';
import { ACWR_CAVEAT } from './workload';

/** A Wednesday: the week in progress has three days, Monday 2 November to today. */
const TODAY = '2026-11-04';
const FIRST = '2024-01-01';
const window = (period: Period = '12w') => periodWindow(TODAY, period, FIRST);
const W12 = window('12w');
const W4 = window('4w');

/** Weekly points on the 12 complete weeks before TODAY's week, oldest first. */
const weekly = (values: readonly (number | null)[], at = W12): SeriesPoint[] =>
	weekStarts(at.weeks).map((day, week) => ({
		at: day,
		value: values[week] ?? null,
		inProgress: false
	}));
const rising = (start: number, perWeek: number) =>
	weekly(Array.from({ length: 12 }, (_, week) => start + perWeek * week));
/** Steady around 100: ±2 with no direction. */
const STEADY = [100, 101.5, 99, 100.5, 98.5, 101, 99.5, 100, 102, 99, 100.5, 99.5];
const steady = (level = 100) => weekly(STEADY.map((value) => (value * level) / 100));

const evidence = (
	subject: string,
	metric: MetricId,
	points: SeriesPoint[],
	at = W12
): Evidence => ({
	subject,
	trend: trendOf(metric, points, at)
});
const UP = (subject: string) => evidence(subject, 'e1rm', rising(100, 2));
const DOWN = (subject: string) => evidence(subject, 'e1rm', rising(140, -2));
const FLAT = (subject: string) => evidence(subject, 'e1rm', steady(120));
const NEW = (subject: string) => evidence(subject, 'e1rm', rising(100, 2).slice(-3));

describe('trendOf', () => {
	it('reads complete weeks with the metric’s own minimal practical change', () => {
		// 2.2 % over the window, very little scatter: past pace's 2 %, short of e1RM's 2.5 %.
		const values = Array.from(
			{ length: 12 },
			(_, week) => 300 + (6.6 / 11) * week + (week % 2) * 0.01
		);
		const points = weekly(values);
		const asE1rm = trendOf('e1rm', points, W12);
		const asPace = trendOf('pace_easy', points, W12);
		expect(asE1rm.result.verdict).toBe('normal_variation');
		expect(asE1rm.result.minChange).toBeCloseTo(300 * METRICS.e1rm.mpc.rel!, 1);
		expect(asPace.result).toMatchObject({ verdict: 'real_trend', direction: 'up', good: false });
		expect(asPace.result.minChange).toBeCloseTo(300 * METRICS.pace_easy.mpc.rel!, 1);
		// An absolute MPC: 2 hard sets.
		const sets = trendOf(
			'hard_sets',
			weekly(Array.from({ length: 12 }, (_, week) => 10 + week * 0.15)),
			W12
		);
		expect(sets.result.minChange).toBe(2);
		expect(sets.result.verdict).toBe('normal_variation');
	});

	it('at 4w gives a 12-week rising series a real trend named for the last 12 weeks', () => {
		const trend = trendOf('e1rm', rising(100, 2), W4);
		expect(trend.result).toMatchObject({
			verdict: 'real_trend',
			direction: 'up',
			good: true,
			n: 12
		});
		expect(trend.window).toMatchObject({
			sameAsPeriod: false,
			label: 'Trend over the last 12 weeks'
		});
		expect(trend.window.weeks).toEqual(W12.weeks);
		// The KPI covers the period's own 4 weeks.
		const figure = kpi('e1rm', { value: 122, weeks: W4.weeks }, { value: 114, weeks: W4.previous });
		expect(figure.words).toBe('Up 8\u00a0kg on the previous 4 weeks');
	});

	it('gives a verdict, naming its window, at every period', () => {
		const long = periodWindow(TODAY, 'all', '2026-05-18');
		const points = weekly(
			Array.from({ length: 24 }, (_, week) => 100 + 2 * week),
			{ ...long, weeks: { from: '2026-05-18', to: W12.weeks!.to, count: 24 } }
		);
		for (const period of PERIODS) {
			const trend = trendOf('e1rm', points, period === 'all' ? long : window(period));
			expect(trend.result.verdict, period).toBe('real_trend');
			expect(trend.window.label, period).toMatch(/^Trend over /);
		}
	});

	it('at all with monthly buckets reads the first month, dated before the first Monday', () => {
		const all = periodWindow(TODAY, 'all', '2023-01-10');
		expect(all).toMatchObject({ bucket: 'month', weeks: { from: '2023-01-09' } });
		const weeks = weekStarts(all.weeks);
		const months = byMonth(
			weekly(
				weeks.map((_, week) => 100 + week),
				all
			)
		);
		expect(months[0]!.at).toBe('2023-01-01');
		expect(trendOf('e1rm', months, all).result.n).toBe(months.length);
	});

	it('with today on a Wednesday, a steady 12-week history is normal variation, never a decline', () => {
		// 6,000 kg a week over Monday, Wednesday and Friday sessions, ±3 %; this week has only
		// Monday and today so far.
		const sessions: Timed[] = [];
		for (const [week, monday] of weekStarts(W12.weeks).entries())
			for (const day of [0, 2, 4])
				sessions.push({
					at: new Date(`${addDays(monday, day)}T17:00:00Z`),
					value: 2000 * (STEADY[week]! / 100)
				});
		sessions.push({ at: new Date('2026-11-02T17:00:00Z'), value: 2000 });
		sessions.push({ at: new Date('2026-11-04T07:00:00Z'), value: 2000 });
		const points = fillWeeks(byWeek(sessions, 'UTC'), W12.weeks, 'zero', W12.inProgress);
		expect(points.at(-1)).toEqual({ at: '2026-11-02', value: 4000, inProgress: true });
		const trend = trendOf('tonnage', points, W12);
		expect(trend.result.verdict).toBe('normal_variation');
		expect(trend.result.n).toBe(12);
		// The same partial week, even unflagged, is past the trend window and never read.
		const unflagged = points.map((point) => ({ ...point, inProgress: false }));
		expect(trendOf('tonnage', unflagged, W12).result).toEqual(trend.result);
		expect(disciplineVerdict('strength', [{ subject: 'Tonnage', trend }]).verdict).toBe('holding');
	});
});

describe('kpi', () => {
	it('compares 12 complete weeks with the 12 before, and nothing unequal', () => {
		expect(W12.weeks).toEqual({ from: '2026-08-10', to: '2026-11-01', count: 12 });
		const figure = kpi(
			'e1rm',
			{ value: 142.5, weeks: W12.weeks },
			{ value: 138, weeks: W12.previous }
		);
		expect(figure).toMatchObject({ value: 142.5, previous: 138, delta: 4.5, change: 'better' });
		expect(figure.words).toBe('Up 4.5\u00a0kg on the previous 12 weeks');
		// 11 weeks against 12, overlapping weeks, or no earlier weeks: no comparison at all.
		const eleven = { from: '2026-05-25', to: '2026-08-09', count: 11 };
		for (const previous of [
			{ value: 138, weeks: eleven },
			{ value: 138, weeks: W12.weeks },
			null
		]) {
			const unequal = kpi('e1rm', { value: 142.5, weeks: W12.weeks }, previous);
			expect(unequal).toMatchObject({ previous: null, delta: null, pct: null, change: null });
			expect(unequal.words).toBe('No earlier weeks like these to compare with');
		}
		expect(
			kpi('tonnage', { value: 0, weeks: W12.weeks }, { value: 0, weeks: W12.previous }).words
		).toBe('Nothing in the previous 12 weeks to compare with');
		expect(
			kpi('tonnage', { value: null, weeks: W12.weeks }, { value: 9, weeks: W12.previous }).words
		).toBe('Nothing logged in these weeks yet');
	});

	it('words a lower-is-better pace as faster or slower', () => {
		const faster = kpi(
			'pace_easy',
			{ value: 330, weeks: W12.weeks },
			{ value: 342, weeks: W12.previous }
		);
		expect(faster).toMatchObject({
			delta: -12,
			change: 'better',
			words: '12\u00a0s/km faster than the previous 12 weeks'
		});
		const slower = kpi(
			'pace_tempo',
			{ value: 290, weeks: W12.weeks },
			{ value: 285, weeks: W12.previous }
		);
		expect(slower).toMatchObject({
			change: 'worse',
			words: '5\u00a0s/km slower than the previous 12 weeks'
		});
		expect(
			kpi('mileage', { value: 120_500, weeks: W12.weeks }, { value: 130_000, weeks: W12.previous })
				.words
		).toBe('Down 9.5\u00a0km on the previous 12 weeks');
		expect(
			kpi('adherence', { value: 90, weeks: W12.weeks }, { value: 80, weeks: W12.previous }).words
		).toBe('Up 10\u00a0points on the previous 12 weeks');
	});

	it('words a change by its rounded figure, and one that rounds to nothing as about the same', () => {
		const words = (id: MetricId, value: number, previous: number) =>
			kpi(id, { value, weeks: W12.weeks }, { value: previous, weeks: W12.previous }).words;
		expect(words('adherence', 80.4, 80)).toBe('About the same as the previous 12 weeks');
		expect(words('pace_easy', 330.3, 330)).toBe('About the same as the previous 12 weeks');
		expect(words('hard_sets', 11.04, 10)).toBe('Up 1\u00a0set on the previous 12 weeks');
	});
});

describe('soFarLine', () => {
	it('compares Monday to Wednesday with last Monday to Wednesday', () => {
		const values: Timed[] = [
			{ at: new Date('2026-10-26T17:00:00Z'), value: 3000 }, // last Monday
			{ at: new Date('2026-10-28T17:00:00Z'), value: 2900 }, // last Wednesday
			{ at: new Date('2026-10-29T17:00:00Z'), value: 3100 }, // last Thursday: not like for like
			{ at: new Date('2026-11-02T17:00:00Z'), value: 3200 },
			{ at: new Date('2026-11-04T07:00:00Z'), value: 3000 }
		];
		const so = soFar(values, W12.inProgress, { timeZone: 'UTC', direction: 'up' });
		const line = soFarLine('tonnage', so);
		expect(line).toEqual({
			metric: 'tonnage',
			value: 6200,
			lastWeek: 5900,
			text: 'This week so far: 6,200\u00a0kg · 5,900\u00a0kg by Wednesday last week'
		});
		expect(Object.keys(line)).not.toContain('change');
		const empty = soFar([], W12.inProgress, { timeZone: 'UTC', direction: 'up' });
		expect(soFarLine('mileage', empty).text).toBe(
			'This week so far: nothing yet · nothing by Wednesday last week'
		);
	});
});

describe('goodness', () => {
	it('judges a value by the metric’s bands and targets, and nothing by its trend', () => {
		expect(goodness('adherence', 85)).toEqual({ level: 'good', words: 'On plan' });
		expect(goodness('adherence', 80)?.level).toBe('good');
		expect(goodness('adherence', 70)?.level).toBe('watch');
		expect(goodness('adherence', 40)?.level).toBe('low');
		expect(goodness('soreness', 2)?.level).toBe('good');
		expect(goodness('soreness', 4.5)?.level).toBe('low');
		expect(goodness('group_sets', 12, [10, 20])?.level).toBe('good');
		expect(goodness('group_sets', 4, [10, 20])?.level).toBe('low');
		expect(goodness('group_sets', 24, [10, 20])?.level).toBe('watch');
		expect(goodness('group_sets', 12)).toBeNull();
		expect(goodness('e1rm', 150)).toBeNull();
		expect(goodness('srpe_load', 3000)).toBeNull();
		expect(goodness('sleep', null)).toBeNull();
	});
});

describe('the ACWR’s words', () => {
	it('always carry the caveat', () => {
		const wordings = [
			kpi('acwr', { value: 1.1, weeks: W12.weeks }, { value: 1, weeks: W12.previous }).words,
			kpi('acwr', { value: 1.1, weeks: W12.weeks }, null).words,
			goodness('acwr', 1.1)!.words,
			goodness('acwr', 1.7)!.words,
			goodness('acwr', 0.5)!.words,
			soFarLine('acwr', {
				value: 1.2,
				lastWeek: 1.1,
				lastWeekDays: { from: '2026-10-26', through: '2026-10-28', days: 3 }
			}).text
		];
		for (const words of wordings) expect(words).toContain(ACWR_CAVEAT.text);
		expect(goodness('acwr', 1.7)?.level).toBe('watch');
		expect(goodness('acwr', 0.5)?.level).toBe('watch');
		expect(goodness('sleep', 7.5)!.words).not.toContain(ACWR_CAVEAT.text);
	});
});

describe('disciplineVerdict', () => {
	it('is improving when every main lift rises', () => {
		const verdict = disciplineVerdict(
			'strength',
			['Bench press', 'Back squat', 'Deadlift', 'Overhead press'].map(UP)
		);
		expect(verdict.verdict).toBe('improving');
		expect(verdict.sentence).toBe('4 of 4 main lifts trending up');
		expect(verdict.window?.label).toBe('Trend over the last 12 weeks');
		expect(verdict.evidence.map((item) => item.words)).toEqual([
			'Back squat: trending up, improving',
			'Bench press: trending up, improving',
			'Deadlift: trending up, improving',
			'Overhead press: trending up, improving'
		]);
	});

	it('is mixed with one real decline, and counts what has too little data', () => {
		const verdict = disciplineVerdict('strength', [
			UP('Back squat'),
			UP('Bench press'),
			UP('Deadlift'),
			DOWN('Overhead press'),
			NEW('Front squat')
		]);
		expect(verdict.verdict).toBe('mixed');
		expect(verdict.counts).toEqual({
			better: 3,
			worse: 1,
			steady: 0,
			moving: 0,
			insufficient: 1,
			judged: 4
		});
		expect(verdict.sentence).toBe(
			'3 of 4 main lifts trending up, 1 declining · 1 without enough data yet'
		);
		expect(verdict.evidence.find((item) => item.subject === 'Overhead press')?.call).toBe('worse');
	});

	it('is declining only when every judged lift declines, and holding without a majority rising', () => {
		expect(disciplineVerdict('strength', [DOWN('Back squat'), DOWN('Deadlift')]).sentence).toBe(
			'2 of 2 main lifts declining'
		);
		const holding = disciplineVerdict('strength', [UP('Back squat'), FLAT('Deadlift')]);
		expect(holding.verdict).toBe('holding');
		expect(holding.sentence).toBe('1 of 2 main lifts trending up, 1 within normal variation');
		expect(disciplineVerdict('strength', [DOWN('Back squat'), FLAT('Deadlift')]).sentence).toBe(
			'1 of 2 main lifts declining, 1 within normal variation'
		);
	});

	it('gives not enough data when nothing has enough', () => {
		const verdict = disciplineVerdict('strength', [NEW('Back squat'), NEW('Deadlift')]);
		expect(verdict.verdict).toBe('not_enough_data');
		expect(verdict.sentence).toBe('Not enough data yet for a verdict on your main lifts');
		expect(disciplineVerdict('running', []).verdict).toBe('not_enough_data');
	});

	it('lists a real trend on a metric with no better way without judging it', () => {
		const load = evidence('Load', 'srpe_load', rising(1000, 60));
		expect(load.trend.result).toMatchObject({ verdict: 'real_trend', good: null });
		const verdict = disciplineVerdict('general', [
			load,
			evidence('Sessions', 'sessions', steady(4))
		]);
		expect(verdict).toMatchObject({
			verdict: 'holding',
			counts: { steady: 1, moving: 1, judged: 1 },
			sentence:
				'1 of 1 training measure within normal variation · 1 moving, not judged better or worse'
		});
		expect(verdict.evidence[0]!.words).toBe('Load: trending up');
		expect(disciplineVerdict('general', [load]).sentence).toBe(
			'No verdict on your training measures · 1 moving, not judged better or worse'
		);
	});

	it('calls faster paces improving, not trending up', () => {
		const faster = (subject: string, metric: MetricId) =>
			evidence(subject, metric, rising(360, -3));
		const verdict = disciplineVerdict('running', [
			faster('Easy pace', 'pace_easy'),
			faster('Tempo pace', 'pace_tempo')
		]);
		expect(verdict.verdict).toBe('improving');
		expect(verdict.sentence).toBe('2 of 2 running measures improving');
		expect(verdict.evidence[0]!.words).toBe('Easy pace: trending down, improving');
	});
});

describe('headline', () => {
	const strength = (items: Evidence[]) => disciplineVerdict('strength', items);
	const running = (items: Evidence[]) => disciplineVerdict('running', items);
	const fasterEasy = evidence('Easy pace', 'pace_easy', rising(360, -3));
	const moreMiles = evidence('Weekly distance', 'mileage', rising(20_000, 1500));

	it('reads a running-only owner on running alone', () => {
		const line = headline([strength([]), running([fasterEasy, moreMiles])]);
		expect(line).toMatchObject({ verdict: 'improving', text: 'Running improving' });
		expect(line.evidence.map((item) => item.area)).toEqual(['running']);
	});

	it('reads a strength-only owner on strength alone', () => {
		const line = headline([
			running([evidence('Easy pace', 'pace_easy', [])]),
			strength([UP('Back squat'), FLAT('Deadlift')])
		]);
		expect(line).toMatchObject({ verdict: 'holding', text: 'Strength holding steady' });
	});

	it('is mixed when any discipline declines, and improving only when all improve', () => {
		const down = strength([DOWN('Back squat')]);
		expect(headline([down, running([fasterEasy])])).toMatchObject({
			verdict: 'mixed',
			text: 'Strength declining · Running improving'
		});
		expect(headline([strength([UP('Back squat')]), running([fasterEasy])]).verdict).toBe(
			'improving'
		);
		expect(
			headline([
				strength([UP('Back squat')]),
				running([evidence('Easy pace', 'pace_easy', steady(330))])
			]).verdict
		).toBe('holding');
		expect(headline([down]).verdict).toBe('declining');
		expect(headline([strength([NEW('Back squat')])])).toEqual({
			verdict: 'not_enough_data',
			text: 'Not enough data yet for a verdict: keep logging',
			evidence: []
		});
	});

	it('words the same evidence the same way, in any order', () => {
		const items = [
			UP('Back squat'),
			DOWN('Overhead press'),
			FLAT('Deadlift'),
			NEW('Front squat'),
			UP('Bench press')
		];
		const once = disciplineVerdict('strength', items);
		const reversed = disciplineVerdict('strength', [...items].reverse());
		const again = disciplineVerdict(
			'strength',
			items.map((item) => ({ ...item }))
		);
		expect(reversed).toEqual(once);
		expect(again).toEqual(once);
		const verdicts: DisciplineVerdict[] = [once, running([fasterEasy])];
		expect(headline([...verdicts].reverse())).toEqual(headline(verdicts));
		expect(Object.values(VERDICT_WORDS)).toContain('holding steady');
	});
});
