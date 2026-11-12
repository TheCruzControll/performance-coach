/**
 * Progress → General's shaping (general-data.ts) on a hand-built general dashboard, and the load
 * reading the general service for ?view=general: sessions and minutes stacked by discipline in
 * STACK_ORDER, adherence with its counts, rate per week and this week so far, load with the
 * sessions it leaves out named, the acute:chronic ratio with its caveat and band (and the owner's
 * placement), Muay Thai's rounds, recovery multiples with notes printed as text, the monthly
 * bucket, and the new, first-week and no-plan states.
 */
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import type { Discipline } from '#lib/domain/profile/catalog.ts';
import type { MetricId } from '#lib/domain/analytics/metrics.ts';
import { periodWindow, trendWindow, type Period } from '#lib/domain/analytics/periods.ts';
import type { TrendResult } from '#lib/domain/analytics/trend.ts';
import type { SeriesPoint } from '#lib/domain/analytics/types.ts';
import {
	ACWR_CAVEAT,
	LOAD_STACK,
	type AcwrPlacement,
	type LoadGroup,
	type MuayThaiFigure,
	type WeekLoad
} from '#lib/domain/analytics/workload.ts';
import type {
	GeneralDashboard,
	GeneralFigure,
	GeneralMetric
} from '#lib/server/services/analytics/general.ts';
import { GENERAL_METRICS } from '#lib/server/services/analytics/general.ts';
import type { TrainingDeps } from '#lib/server/services/training/shared.ts';
import { generalData, NO_PLAN_HINT, ZONE_WORDS, type GeneralData } from './general-data.ts';
import GeneralTrends from './GeneralTrends.svelte';
import GeneralView from './GeneralView.svelte';
import { loadProgress, type ProgressRequest } from './load.ts';

/** The view as the server sends it: its trends rendered apart and served in place (+page.ts). */
const sent = (general: GeneralData) =>
	render(GeneralView, {
		props: { general, served: render(GeneralTrends, { props: { general } }).body }
	}).body;

/** A Wednesday: Monday to Wednesday are the week in progress. */
const TODAY = '2026-11-04';
const FIRST = '2026-01-05';
const MARKUP = '<b>Legs</b> heavy <img src=x onerror=alert(1)>';

const addWeeks = (monday: string, n: number) =>
	new Date(Date.parse(`${monday}T00:00:00Z`) + n * 7 * 86_400_000).toISOString().slice(0, 10);

const steady = { verdict: 'normal_variation', n: 12 } as TrendResult;

function build(period: Period = '12w', first = FIRST) {
	const window = periodWindow(TODAY, period, first);
	const count = window.weeks!.count;
	const starts = [...Array(count + 1).keys()].map((i) => addWeeks(window.weeks!.from, i));
	/** Complete weeks from `of`, then this week from `now`. */
	const weekly = <T>(of: (i: number) => T, now: T) => ({
		weeks: starts.slice(0, -1).map((weekStart, i) => ({
			weekStart,
			inProgress: false as const,
			...of(i)
		})),
		inProgress: { weekStart: starts.at(-1)!, inProgress: true as const, ...now }
	});
	const points = (values: (number | null)[]): SeriesPoint[] =>
		values.map((value, i) => ({ at: starts[i]!, value, inProgress: i === values.length - 1 }));
	return { window, count, starts, weekly, points };
}

/**
 * Twelve weeks of 2 strength sessions (an hour each), 2 runs (45 min), a 90-minute Muay Thai
 * class with 6 rounds and an athletic session with no duration; this week 1 strength and 1 run.
 */
function dashboard(
	parts: Partial<GeneralDashboard> = {},
	{ period = '12w' as Period, first = FIRST, placement = 'shown' as AcwrPlacement } = {}
): GeneralDashboard {
	const { window, count, weekly, points } = build(period, first);
	const sessions: Partial<Record<Discipline, number>> = {
		strength: 2,
		running: 2,
		muay_thai: 1,
		athletic: 1
	};
	const seconds: Partial<Record<Discipline, number | null>> = {
		strength: 7200,
		running: 5400,
		muay_thai: 5400,
		athletic: null
	};
	const now = { strength: 1, running: 1 };
	const loadOf = (values: Partial<Record<LoadGroup, number>>) => ({
		load: Object.values(values).reduce((a, b) => a + b, 0),
		byGroup: LOAD_STACK.map((group) => ({ group, load: values[group] ?? 0 })),
		sessions: 6,
		unknown: []
	});
	const counts = (completed: number, planned: number, missed = 0, pending = 0) => ({
		planned,
		completed,
		skipped: planned - completed - missed - pending,
		missed,
		pending,
		moved: 0,
		pct: (completed / (planned - pending)) * 100,
		noRate: null,
		extra: 0
	});
	const mt = (sessions: number, rounds: number | null): MuayThaiFigure => ({
		sessions,
		minutes: sessions * 90,
		load: sessions * 630,
		unknown: [],
		hard: sessions,
		rounds: { total: rounds, byKind: rounds === null ? {} : { class: rounds } },
		ignoredKeys: [],
		malformed: []
	});
	const figure = (metric: GeneralMetric, value: number | null, shown: string | null) =>
		({
			metric,
			label: metric,
			kind: 'calculated',
			method: '',
			caveat: null,
			value,
			shown,
			series: points([...Array(count).fill(value), value === null ? null : value / 2]),
			comparison: {
				metric,
				value,
				previous: null,
				delta: null,
				pct: null,
				change: null,
				words: ''
			},
			trend: { metric: metric as MetricId, window: trendWindow(window), result: steady },
			soFar: null,
			availability: { ready: true }
		}) satisfies GeneralFigure;
	const figures = Object.fromEntries(
		GENERAL_METRICS.map((id) => [id, figure(id, 6, '6')])
	) as Record<GeneralMetric, GeneralFigure>;
	figures.adherence = figure('adherence', 90, '90%');
	figures.adherence.series = points([...Array(count - 1).fill(100), 50, 40]);
	figures.sessions.soFar = { metric: 'sessions', value: 2, lastWeek: 3, text: '' };
	figures.sleep = figure('sleep', 7.5, '7.5 h');
	figures.training_time = figure('training_time', 18_000, '5 h');
	const recoveryWeek = { notes: 1, ...meansOf(7.5) };
	const board: GeneralDashboard = {
		period,
		window,
		trendWindow: trendWindow(window),
		previous: window.previous,
		units: { weight: 'kg', distance: 'km' },
		sessions: {
			...weekly(() => ({ sessions: 6, byDiscipline: sessions }), {
				sessions: 2,
				byDiscipline: now
			}),
			total: { sessions: 6 * count, byDiscipline: {} }
		},
		time: {
			...weekly(() => ({ seconds: 18_000, byDiscipline: seconds, untimed: [] }), {
				seconds: 6300,
				byDiscipline: { strength: 3600, running: 2700 },
				untimed: []
			}),
			total: {
				seconds: 18_000 * count,
				byDiscipline: {},
				untimed: [
					{ id: 'w-a', title: 'Athletic', date: '2026-10-28', discipline: 'athletic' as const }
				]
			}
		},
		adherence: {
			...weekly((i) => ({ ...counts(i === count - 1 ? 2 : 5, 5, 0), through: '' }), {
				...counts(2, 6, 1, 3),
				through: TODAY
			}),
			total: { ...counts(57, 60, 1), extra: 3 }
		},
		load: {
			...weekly<Omit<WeekLoad, 'weekStart' | 'inProgress'>>(
				() => ({
					...loadOf({ strength: 960, conditioning: 0, combat: 630, running: 540 }),
					through: '',
					monotony: 1.4,
					strain: 2982
				}),
				{ ...loadOf({ strength: 480, running: 270 }), through: TODAY, monotony: null, strain: null }
			),
			total: {
				...loadOf({ strength: 960 * count }),
				unknown: [
					{
						...{ id: 'w-a', title: 'Athletic', date: '2026-10-28', group: 'conditioning' },
						missing: 'duration'
					}
				]
			}
		} as GeneralDashboard['load'],
		daily: [],
		acwr: {
			current: {
				...{ from: '2026-09-09', through: TODAY, days: 56, acute: 300, chronic: 268 },
				...{ ratio: 1.1194, zone: 'typical', unknown: 0, caveat: ACWR_CAVEAT }
			},
			series: points([...Array(count).fill(1.05), 1.1194]),
			placement
		},
		muayThai: { ...weekly(() => mt(1, 6), mt(0, null)), total: mt(count, 6 * count + 4) },
		recovery: {
			...weekly(() => recoveryWeek, recoveryWeek),
			total: { ...recoveryWeek, notes: count },
			series: {} as GeneralDashboard['recovery']['series'],
			latest: [
				{ id: 'n-2', notedOn: '2026-10-26', text: { untrusted_text: MARKUP } },
				{ id: 'n-1', notedOn: '2026-10-19', text: { untrusted_text: 'Slept well' } }
			]
		},
		figures,
		...parts
	};
	return board;
}

function meansOf(sleep: number) {
	const m = (mean: number) => ({ mean, count: 1 });
	return { sleepHours: m(sleep), soreness: m(2), energy: m(4), stress: m(2) };
}

const columns = (table: { columns: readonly { label: string }[] }) =>
	table.columns.map((c) => c.label);

describe('generalData', () => {
	it('stacks sessions and minutes by discipline in STACK_ORDER, athletic as conditioning', () => {
		const g = generalData(dashboard());
		const sessions = g.sessions.chart;
		expect(sessions.data.series.map((s) => [s.key, s.label, s.token])).toEqual([
			['strength', 'Strength', '--chart-strength'],
			['conditioning', 'Conditioning', '--chart-conditioning'],
			['combat', 'Muay Thai', '--chart-combat'],
			['running', 'Running', '--chart-running']
		]);
		expect(columns(sessions.table)).toEqual([
			'Strength',
			'Conditioning',
			'Muay Thai',
			'Running',
			'Total'
		]);
		expect(sessions.table.rows[0]!.values).toEqual(['2', '1', '1', '2', '6']);
		// This week so far: the outlined column, with only what was done.
		expect(sessions.data.slots.at(-1)).toMatchObject({ inProgress: true });
		expect(sessions.table.rows.at(-1)!.values).toEqual(['1', '0', '0', '1', '2']);

		const time = g.time.chart;
		expect(time.data.unit).toBe('min');
		// The athletic session has no duration: never 0 minutes, so it draws nothing, and is named.
		expect(columns(time.table)).toEqual(['Strength', 'Muay Thai', 'Running', 'Total']);
		expect(time.table.rows[0]!.values).toEqual(['120', '90', '90', '300']);
		expect(time.summary).toBe('About 300 min a week, stacked by discipline.');
		expect(g.time.missing).toBe('1 session without a duration, left out: Athletic (Wed 28 Oct)');
		expect(g.sessions.tile.soFar).toMatchObject({
			value: '2\u00a0sessions',
			lastWeek: '3\u00a0sessions'
		});
	});

	it('gives adherence its tile, the period’s counts, each week’s rate and this week so far', () => {
		const g = generalData(dashboard());
		expect(g.noPlan).toBeNull();
		expect(g.adherence.tile).toMatchObject({ value: '90%', canonical: 90 });
		expect(g.adherence.counts.map((c) => [c.key, c.label, c.value])).toEqual([
			['completed', 'Completed', 57],
			['skipped', 'Skipped', 2],
			['missed', 'Missed', 1],
			['extra', 'Off plan', 3]
		]);
		expect(g.adherence.soFar).toBe('This week so far: 2 of 6 done · 3 to come · 1 missed');
		const { data, summary, table } = g.adherence.chart;
		expect(data.target).toEqual([80, null]);
		expect(data.series[0]!.values.slice(-3)).toEqual([
			{ value: 100, text: '100' },
			{ value: 50, text: '50' },
			{ value: 40, text: '40' }
		]);
		expect(columns(table)).toEqual(['Adherence']);
		expect(summary).toBe('57 of 60 sessions due were done.');
	});

	it('names the earlier period only over a tile that shows a change against it', () => {
		const d = dashboard();
		const fresh = generalData(d);
		expect(fresh.adherence.tile.delta).toBeNull();
		expect(fresh.adherence.context.comparison).toBeNull();
		// Steady over its weeks: the tile says so in place of 'No earlier period to compare with'.
		expect(fresh.adherence.tile.verdict).toEqual({ verdict: 'normal_variation' });
		const compared = {
			...d.figures.adherence.comparison,
			previous: 80,
			delta: 10,
			change: 'better'
		};
		const figures = { ...d.figures, adherence: { ...d.figures.adherence, comparison: compared } };
		const g = generalData({ ...d, figures } as typeof d);
		expect(g.adherence.tile.delta).toMatchObject({ value: 10, against: 'the 12 weeks before' });
		expect(g.adherence.context.comparison).toBe('Compared with the 12 weeks before');
		expect(g.sessions.context.comparison).toBeNull();
	});

	it('stacks load by discipline and names the sessions it leaves out', () => {
		const g = generalData(dashboard());
		const { data, context, table } = g.load.chart;
		expect(data.unit).toBe('AU');
		// A group with nothing in any week (hypertrophy, and conditioning's zeros) is left out.
		expect(data.series.map((s) => s.key)).toEqual(['strength', 'combat', 'running']);
		expect(table.rows[0]!.values).toEqual(['960', '630', '540', '2,130']);
		expect(context).toContain('Calculated: minutes × session RPE');
		expect(g.load.missing).toBe(
			'1 session without an RPE or a duration, left out: Athletic (Wed 28 Oct)'
		);
	});

	it('shows the acute:chronic ratio over its typical band with its caveat in words', () => {
		const { acwr } = generalData(dashboard());
		expect(acwr).toMatchObject({
			more: false,
			caveat: ACWR_CAVEAT.text,
			current: { value: 1.1194, text: '1.12', zone: ZONE_WORDS.typical }
		});
		expect(acwr!.chart.data.target).toEqual([0.8, 1.3]);
		expect(acwr!.chart.data.series[0]!.points.at(-1)).toEqual({ value: 1.12, text: '1.12' });
		expect(acwr!.chart.summary).toBe('1.12 today, against a typical 0.8–1.3.');
		const html = sent(generalData(dashboard()));
		expect(html).toContain(ACWR_CAVEAT.text);
	});

	it('follows the owner’s placement: behind More, or dropped', () => {
		const more = generalData(dashboard({}, { placement: 'more' }));
		expect(more.acwr!.more).toBe(true);
		expect(sent(more)).toMatch(/<details><summary[^>]*>Acute:chronic load<\/summary>/);
		const dropped = generalData(dashboard({}, { placement: 'dropped' }));
		expect(dropped.acwr).toBeNull();
		expect(sent(dropped)).not.toContain('data-testid="acwr-caveat"');
	});

	it('says when there are too few days for a ratio', () => {
		const base = dashboard();
		const g = generalData(dashboard({ acwr: { ...base.acwr, current: null } }));
		expect(g.acwr!.current).toBeNull();
		expect(g.acwr!.waiting).toBe('Available after 28 days of training');
	});

	it('gives Muay Thai its sessions, minutes, hard sessions and rounds', () => {
		const g = generalData(dashboard());
		expect(g.muayThai.trained).toBe(true);
		expect(g.muayThai.counts.map((c) => [c.label, c.value])).toEqual([
			['Sessions', 12],
			['Minutes', 1080],
			['Hard (RPE 7+)', 12],
			['Rounds', 76]
		]);
		const none = { ...build().weekly(() => mtNone(), mtNone()), total: mtNone() };
		const quiet = generalData(dashboard({ muayThai: none }));
		expect(quiet.muayThai.trained).toBe(false);
		expect(quiet.muayThai.counts.map((c) => c.key)).toEqual(['sessions', 'minutes', 'hard']);
	});

	it('draws recovery as small multiples and prints notes as text, never as markup', () => {
		const g = generalData(dashboard());
		expect(g.recovery.multiples.map((m) => m.id)).toEqual([
			'sleep',
			'soreness',
			'energy',
			'stress'
		]);
		expect(g.recovery.multiples[0]!.chart.summary).toBe('A mean of 7.5 h in these weeks.');
		expect(g.recovery.notes).toEqual([
			{ id: 'n-2', on: 'Mon 26 Oct', text: MARKUP },
			{ id: 'n-1', on: 'Mon 19 Oct', text: 'Slept well' }
		]);
		const html = sent(g);
		expect(html).not.toContain('<b>Legs</b>');
		expect(html).not.toContain('<img');
		expect(html).toContain('&lt;b>Legs&lt;/b> heavy &lt;img src=x onerror=alert(1)>');
	});

	it('charts each month’s average week over a long period', () => {
		const g = generalData(dashboard({}, { period: 'all', first: '2024-06-03' }));
		const { data, context, table } = g.sessions.chart;
		expect(data.title).toBe('Sessions by month');
		expect(context).toContain('Average week of each month');
		expect(table.rowHeader).toBe('Month');
		expect(data.slots[0]!.label).toMatch(/^[A-Z][a-z]{2} 2024$/);
		expect(data.slots.at(-1)).toMatchObject({ inProgress: true });
		expect(table.rows[1]!.values).toEqual(['2', '1', '1', '2', '6']);
	});

	it('is a first week with only this week logged, new with nothing, and says when nothing is planned', () => {
		const base = dashboard();
		const { points, count } = build();
		const zero = (soFar: number) => ({
			...base.figures,
			sessions: { ...base.figures.sessions, series: points([...Array(count).fill(0), soFar]) }
		});
		const now = (sessions: number) => ({
			...base.sessions,
			inProgress: { ...base.sessions.inProgress, sessions }
		});
		expect(generalData(base).stage).toBe('history');
		expect(generalData(dashboard({ figures: zero(2), sessions: now(2) })).stage).toBe('first_week');
		const unplanned = {
			...base.adherence,
			total: { ...base.adherence.total, planned: 0 },
			inProgress: { ...base.adherence.inProgress, planned: 0 }
		};
		const g = generalData(dashboard({ figures: zero(0), sessions: now(0), adherence: unplanned }));
		expect(g.stage).toBe('new');
		expect(g.noPlan).toBe(NO_PLAN_HINT);
		const html = sent(g);
		expect(html).toContain('Your training trends start with your first session');
		expect(html).toContain(NO_PLAN_HINT);
		expect(html).not.toContain('data-testid="chart-plot"');
	});
});

function mtNone(): MuayThaiFigure {
	return {
		...{ sessions: 0, minutes: 0, load: 0, unknown: [], hard: 0 },
		...{ rounds: { total: null, byKind: {} }, ignoredKeys: [], malformed: [] }
	};
}

describe('loadProgress, the General view', () => {
	const request: ProgressRequest = {
		view: 'general',
		period: '12w',
		origin: { requestId: 'req-1', method: 'GET', path: '/progress', routeId: '/(app)/progress' }
	};
	const db = {} as NonNullable<TrainingDeps['db']>;
	const NOW = new Date('2026-11-04T12:00:00Z');
	const today = vi.fn(async () => TODAY);

	it('reads the general dashboard, not another view’s, for the asked period', async () => {
		const general = vi.fn(async () => dashboard());
		const [overview, strength, running] = [vi.fn(), vi.fn(), vi.fn()];
		const data = await loadProgress('owner-1', request, NOW, {
			...{ db, general, overview, strength, running, today }
		});
		expect(general).toHaveBeenCalledWith(db, 'owner-1', { period: '12w', today: TODAY });
		for (const other of [overview, strength, running]) expect(other).not.toHaveBeenCalled();
		expect(data).toMatchObject({ failed: false, view: 'general', period: '12w' });
		expect(data.failed === false && data.view === 'general' && data.general.stage).toBe('history');
	});

	it('records a failed read with its view and fails soft', async () => {
		const record = vi.fn(async () => null);
		const failure = new Error('connection reset');
		const data = await loadProgress('owner-1', request, NOW, {
			db,
			general: async () => {
				throw failure;
			},
			record,
			today
		});
		expect(data).toEqual({ failed: true, view: 'general', period: '12w' });
		expect(record).toHaveBeenCalledWith(
			expect.objectContaining({
				error: failure,
				context: { load: 'progress', view: 'general', period: '12w' }
			}),
			{ db: undefined }
		);
	});
});
