/**
 * 'Am I improving?' (PRD §10): the verdicts, comparisons and so-far lines the overview, the
 * reviews and the coach show, composed once on the metric catalogue (metrics.ts) and the trend
 * classifier (trend.ts). The rules are written down and never optimistic by default:
 *
 * - A trend reads only the complete weeks of trendWindow(period): a point in progress, or dated
 *   after the last complete week, never counts, so a Wednesday never looks like a decline.
 * - A KPI compares complete weeks with as many complete weeks before them, or not at all.
 * - The week in progress is a 'so far' line set against the same days of last week, with no
 *   verdict and no better or worse.
 * - A discipline is improving only when more than IMPROVING_SHARE of its judged evidence is a real
 *   trend the better way and none goes the worse way; one real decline makes it mixed. Evidence
 *   without enough data, and a real trend on a metric with no better way (direction 'none'), is
 *   listed and counted, never judged.
 *
 * Words use the catalogue's canonical units unless a `format` is given (the services pass one in
 * the profile's units). The verdict rules and their words are judgements the owner can change here.
 *
 * Conventions for src/lib/domain/analytics (M6): pure, imported by path (no index file), no zod,
 * no runtime import of domain/programming or domain/exercises. Server-only at runtime: this is not
 * in scripts/analytics-client-imports.test.ts's CLIENT_SAFE; screens receive its words.
 */
import { addDays, weekdayOf } from '../calendar.ts';
import { WEEKDAY_INFO } from '../profile/catalog.ts';
import { cleanFloat, formatDuration, NBSP, roundEstimate } from '../units.ts';
import { METRIC_AREAS, METRICS } from './metrics.ts';
import type { GoodLevel, Metric, MetricArea, MetricId, Range } from './metrics.ts';
import { trendWindow } from './periods.ts';
import type { PeriodWindow, TrendWindow, WeekRange } from './periods.ts';
import { compare } from './series.ts';
import type { SoFar } from './series.ts';
import { classifyTrend } from './trend.ts';
import type { TrendResult } from './trend.ts';
import type { Comparison, SeriesPoint } from './types.ts';

/** More than this share of the judged evidence must be improving for 'improving'. */
export const IMPROVING_SHARE = 0.5;

export type Verdict = 'improving' | 'holding' | 'mixed' | 'declining' | 'not_enough_data';

export const VERDICT_WORDS: Readonly<Record<Verdict, string>> = {
	improving: 'improving',
	holding: 'holding steady',
	mixed: 'mixed',
	declining: 'declining',
	not_enough_data: 'not enough data yet'
};

/** What a discipline's evidence is called: singular, plural. */
export const EVIDENCE_NOUN: Readonly<Record<MetricArea, readonly [string, string]>> = {
	strength: ['main lift', 'main lifts'],
	running: ['running measure', 'running measures'],
	general: ['training measure', 'training measures'],
	recovery: ['recovery measure', 'recovery measures']
};

const AREA_LABEL: Readonly<Record<MetricArea, string>> = {
	strength: 'Strength',
	running: 'Running',
	general: 'Training',
	recovery: 'Recovery'
};

/** Formats a canonical value (`as: 'value'`) or the size of a change (`as: 'delta'`, never negative). */
export type Format = (metric: Metric, value: number, as: 'value' | 'delta') => string;

/** One number format per number of decimals, made once: toLocaleString makes one per call. */
const formats = new Map<number, Intl.NumberFormat>();
const number = (value: number, decimals: number) => {
	let format = formats.get(decimals);
	if (!format) {
		format = new Intl.NumberFormat('en-US', { maximumFractionDigits: decimals });
		formats.set(decimals, format);
	}
	return format.format(cleanFloat(value, decimals) + 0);
};
const count = (value: number, one: string, many: string) =>
	`${number(value, 1)}${NBSP}${cleanFloat(value, 1) === 1 ? one : many}`;
function hours(seconds: number): string {
	const minutes = Math.round(seconds / 60);
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	if (h === 0) return `${m}${NBSP}min`;
	return m === 0 ? `${h}${NBSP}h` : `${h}${NBSP}h ${m}${NBSP}min`;
}

/**
 * Canonical display: '6,200 kg', '5:30 /km' or '12 s/km', '42.2 km', '85%' or '10 points', each
 * number and unit joined by a non-breaking space so they never part; an estimated max to 0.5 kg.
 */
export const formatCanonical: Format = (metric, value, as) => {
	switch (metric.unit) {
		case 'kg':
			return `${number(metric.kind === 'estimated' ? roundEstimate(value, 'kg') : value, 1)}${NBSP}kg`;
		case 'sets':
			return count(value, 'set', 'sets');
		case 'rpe':
			return as === 'value' ? `RPE${NBSP}${number(value, 1)}` : `${number(value, 1)}${NBSP}RPE`;
		case 'm':
			return `${number(value / 1000, 1)}${NBSP}km`;
		case 's/km':
			return as === 'value'
				? `${formatDuration(value)}${NBSP}/km`
				: `${number(value, 0)}${NBSP}s/km`;
		case 'runs':
			return count(value, 'run', 'runs');
		case 'sessions':
			return count(value, 'session', 'sessions');
		case 's':
			return hours(value);
		case 'pct':
			return as === 'value' ? `${number(value, 0)}%` : count(Math.round(value), 'point', 'points');
		case 'AU':
			return `${number(value, 0)}${NBSP}AU`;
		case 'ratio':
			return number(value, 2);
		case 'h':
			return `${number(value, 1)}${NBSP}h`;
		case 'scale':
			return as === 'value' ? `${number(value, 1)}${NBSP}/${NBSP}5` : number(value, 1);
	}
};

/** `words`, followed by the metric's caveat when every sentence about it must carry one. */
const withCaveat = (metric: Metric, words: string) =>
	metric.caveatAlways && metric.caveat !== null ? `${words}. ${metric.caveat}` : words;

const weeksWord = (n: number) => (n === 1 ? 'week' : `${n} weeks`);

// ---- Trends ----------------------------------------------------------------------------------

/** A metric's verdict, with the weeks it read. */
export interface MetricTrend {
	metric: MetricId;
	window: TrendWindow;
	result: TrendResult;
}

/** A complete point dated in `weeks`; a monthly point (series.ts's byMonth) is dated on the 1st. */
function within(point: SeriesPoint, weeks: WeekRange, bucket: PeriodWindow['bucket']): boolean {
	const from = bucket === 'month' ? `${addDays(weeks.from, 3).slice(0, 7)}-01` : weeks.from;
	return !point.inProgress && point.at >= from && point.at <= weeks.to;
}

/**
 * classifyTrend over the complete weeks of trendWindow(window), with the metric's direction and
 * minimal practical change. Points in progress, or outside those weeks, are left out.
 */
export function trendOf(
	metric: MetricId,
	points: readonly SeriesPoint[],
	window: PeriodWindow
): MetricTrend {
	const trend = trendWindow(window);
	const { weeks } = trend;
	const used = weeks === null ? [] : points.filter((point) => within(point, weeks, window.bucket));
	const { direction, mpc } = METRICS[metric];
	return { metric, window: trend, result: classifyTrend(used, { direction, mpc }) };
}

// ---- KPIs and the week so far ----------------------------------------------------------------

/** A figure over complete weeks: its value (null: no data) and the weeks it covers. */
export interface PeriodFigure {
	value: number | null;
	weeks: WeekRange | null;
}

export interface Kpi extends Comparison {
	metric: MetricId;
	value: number | null;
	previous: number | null;
	words: string;
}

const NO_COMPARISON: Comparison = { delta: null, pct: null, change: null };

/**
 * A period's figure against the previous period: 'Up 4.5 kg on the previous 12 weeks', '12 s/km
 * faster than the previous 12 weeks'. Compared only when both cover complete weeks of the same
 * count, the previous ending before the current begins; otherwise there is no comparison.
 */
export function kpi(
	id: MetricId,
	current: PeriodFigure,
	previous: PeriodFigure | null,
	format: Format = formatCanonical
): Kpi {
	const metric = METRICS[id];
	const like =
		current.weeks !== null &&
		previous?.weeks != null &&
		previous.weeks.count === current.weeks.count &&
		previous.weeks.to < current.weeks.from;
	const comparison = like
		? compare(current.value, previous.value, metric.direction)
		: NO_COMPARISON;
	const span = `the previous ${weeksWord(current.weeks?.count ?? 0)}`;
	/** A change as shown: one that shows as nothing ('0 points') is about the same. */
	const size = (delta: number) => format(metric, Math.abs(delta), 'delta');
	let words: string;
	if (current.weeks === null || current.value === null) words = 'Nothing logged in these weeks yet';
	else if (!like) words = 'No earlier weeks like these to compare with';
	else if (comparison.delta === null) words = `Nothing in ${span} to compare with`;
	else if (comparison.delta === 0) words = `The same as ${span}`;
	else if (size(comparison.delta) === size(0)) words = `About the same as ${span}`;
	else {
		const rising = comparison.delta > 0;
		words =
			metric.unit === 's/km'
				? `${size(comparison.delta)} ${rising ? 'slower' : 'faster'} than ${span}`
				: `${rising ? 'Up' : 'Down'} ${size(comparison.delta)} on ${span}`;
	}
	return {
		metric: id,
		value: current.value,
		previous: like ? previous.value : null,
		...comparison,
		words: withCaveat(metric, words)
	};
}

export interface SoFarLine {
	metric: MetricId;
	value: number | null;
	lastWeek: number | null;
	text: string;
}

/**
 * The week in progress beside the same days of last week (series.ts's soFar): 'This week so far:
 * 6,200 kg · 5,900 kg by Wednesday last week'. Two figures and no verdict.
 */
export function soFarLine(
	id: MetricId,
	so: Pick<SoFar, 'value' | 'lastWeek' | 'lastWeekDays'>,
	format: Format = formatCanonical
): SoFarLine {
	const metric = METRICS[id];
	const show = (value: number | null, none: string) =>
		value === null ? none : format(metric, value, 'value');
	const day = WEEKDAY_INFO[weekdayOf(so.lastWeekDays.through)].label;
	const text =
		`This week so far: ${show(so.value, 'nothing yet')} · ` +
		`${show(so.lastWeek, 'nothing')} by ${day} last week`;
	return { metric: id, value: so.value, lastWeek: so.lastWeek, text: withCaveat(metric, text) };
}

// ---- What counts as good ---------------------------------------------------------------------

export interface Goodness {
	level: GoodLevel;
	words: string;
}

const inRange = (value: number, { from, to }: Range) =>
	(from === undefined || value >= from) && (to === undefined || value <= to);

/**
 * A value against the metric's 'good' rule: good, watch or low, with its words. Null without a
 * value, for a metric judged by its trend or by nothing, and for a target metric without its
 * week's `target` range.
 */
export function goodness(
	id: MetricId,
	value: number | null,
	target?: readonly [number, number]
): Goodness | null {
	const metric = METRICS[id];
	const rule = metric.good;
	if (value === null) return null;
	let level: GoodLevel;
	if (rule.type === 'bands') {
		if (inRange(value, rule.good)) level = 'good';
		else level = rule.watch.some((range) => inRange(value, range)) ? 'watch' : 'low';
	} else if (rule.type === 'target' && target !== undefined) {
		const [lo, hi] = target;
		level = value < lo ? 'low' : value > hi ? 'watch' : 'good';
	} else return null;
	return { level, words: withCaveat(metric, rule.levels[level]) };
}

// ---- Verdicts --------------------------------------------------------------------------------

/** One piece of evidence: what it is about ('Back squat') and its metric's trend. */
export interface Evidence {
	subject: string;
	trend: MetricTrend;
}

/** 'moving': a real trend on a metric with no better way, which is never judged. */
export type EvidenceCall = 'better' | 'worse' | 'steady' | 'moving' | 'insufficient';

export interface JudgedEvidence extends Evidence {
	call: EvidenceCall;
	words: string;
}

export interface DisciplineVerdict {
	area: MetricArea;
	verdict: Verdict;
	counts: Record<EvidenceCall, number> & { judged: number };
	sentence: string;
	/** The weeks the verdicts read, from the first evidence; null without any. */
	window: TrendWindow | null;
	evidence: JudgedEvidence[];
}

function judge(evidence: Evidence): JudgedEvidence {
	const { result } = evidence.trend;
	let call: EvidenceCall;
	let words: string;
	if (result.verdict === 'insufficient_data')
		[call, words] = ['insufficient', 'not enough data yet'];
	else if (result.verdict === 'normal_variation')
		[call, words] = ['steady', 'within normal variation'];
	else {
		const moving = result.direction === 'up' ? 'trending up' : 'trending down';
		call = result.good === null ? 'moving' : result.good ? 'better' : 'worse';
		words =
			result.good === null ? moving : result.good ? `${moving}, improving` : `${moving}, declining`;
	}
	return { ...evidence, call, words: `${evidence.subject}: ${words}` };
}

/**
 * The measures with a real trend but no better way, by name: 'Strain is rising, neither better
 * nor worse on its own'; 'Strain and Training load are changing, neither better nor worse on
 * their own'.
 */
function movingWords(moving: readonly JudgedEvidence[]): string {
	if (moving.length === 1) {
		const [only] = moving as [JudgedEvidence];
		const { result } = only.trend;
		const way =
			result.verdict === 'real_trend' && result.direction === 'down' ? 'falling' : 'rising';
		return `${only.subject} is ${way}, neither better nor worse on its own`;
	}
	const names = moving.map((item) => item.subject);
	const list = `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
	return `${list} are changing, neither better nor worse on their own`;
}

const order = (a: Evidence, b: Evidence) =>
	a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : a.trend.metric < b.trend.metric ? -1 : 0;

/**
 * A discipline's verdict from its evidence: improving, holding, mixed, declining, or
 * not_enough_data when nothing can be judged, with its counts and a sentence ('3 of 4 main lifts
 * trending up'). The same evidence in any order gives the same verdict and words.
 */
export function disciplineVerdict(
	area: MetricArea,
	evidence: readonly Evidence[]
): DisciplineVerdict {
	const judged = [...evidence].sort(order).map(judge);
	const counts = { better: 0, worse: 0, steady: 0, moving: 0, insufficient: 0, judged: 0 };
	for (const item of judged) counts[item.call] += 1;
	counts.judged = counts.better + counts.worse + counts.steady;
	const { better, worse, steady, moving, insufficient, judged: n } = counts;
	let verdict: Verdict;
	if (n === 0) verdict = 'not_enough_data';
	else if (worse === n) verdict = 'declining';
	else if (worse > 0) verdict = 'mixed';
	else verdict = better > n * IMPROVING_SHARE ? 'improving' : 'holding';
	const [one, many] = EVIDENCE_NOUN[area];
	const of = (k: number) => `${k} of ${n} ${n === 1 ? one : many}`;
	const ups = judged.filter((item) => item.call === 'better');
	const up = ups.every((item) => METRICS[item.trend.metric].direction === 'up')
		? 'trending up'
		: 'improving';
	const parts: Record<Verdict, string> = {
		improving: `${of(better)} ${up}`,
		holding:
			better > 0
				? `${of(better)} ${up}, ${steady} within normal variation`
				: `${of(steady)} within normal variation`,
		mixed:
			better > 0
				? `${of(better)} ${up}, ${worse} declining`
				: `${of(worse)} declining, ${steady} within normal variation`,
		declining: `${of(worse)} declining`,
		not_enough_data:
			moving > 0
				? `No verdict on your ${many}`
				: `Not enough data yet for a verdict on your ${many}`
	};
	const notes = [
		...(moving > 0 ? [movingWords(judged.filter((item) => item.call === 'moving'))] : []),
		...(insufficient > 0 && n + moving > 0 ? [`${insufficient} without enough data yet`] : [])
	];
	return {
		area,
		verdict,
		counts,
		sentence: [parts[verdict], ...notes].join(' · '),
		window: judged[0]?.trend.window ?? null,
		evidence: judged
	};
}

export interface Headline {
	verdict: Verdict;
	text: string;
	/** The disciplines with a verdict, in the catalogue's order; each lists its own evidence. */
	evidence: DisciplineVerdict[];
}

/**
 * The overview's one line from the disciplines' verdicts: 'Strength improving · Running holding
 * steady'. Disciplines without enough data are left out. Overall: declining when all are, mixed
 * when any declines or is mixed, improving only when all improve, otherwise holding.
 */
export function headline(verdicts: readonly DisciplineVerdict[]): Headline {
	const shown = METRIC_AREAS.flatMap((area) =>
		verdicts.filter((item) => item.area === area && item.verdict !== 'not_enough_data')
	);
	const all = (verdict: Verdict) => shown.every((item) => item.verdict === verdict);
	const any = (verdict: Verdict) => shown.some((item) => item.verdict === verdict);
	let verdict: Verdict;
	if (shown.length === 0) verdict = 'not_enough_data';
	else if (all('declining')) verdict = 'declining';
	else if (any('declining') || any('mixed')) verdict = 'mixed';
	else verdict = all('improving') ? 'improving' : 'holding';
	const text =
		shown.length === 0
			? 'Not enough data yet for a verdict: keep logging'
			: shown.map((item) => `${AREA_LABEL[item.area]} ${VERDICT_WORDS[item.verdict]}`).join(' · ');
	return { verdict, text, evidence: shown };
}
