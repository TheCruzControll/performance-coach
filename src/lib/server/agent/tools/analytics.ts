/**
 * The coach's analytics tools (PRD §4, §10; the M5 plan's tools-analytics): numbers code computed,
 * each with how it was computed, so an answer's `[metric method=…]` repeats the method and cites
 * the figure's sources. Each tool returns the analytics service's result as it is
 * (services/analytics), owner-scoped by the session's owner:
 *
 * - get_weekly_training_summary: one Monday-to-Sunday week, this one unless asked.
 * - get_training_load: acute and chronic sRPE load and their ratio, with the ratio's caveat.
 * - get_performance_trends: weekly sessions, minutes, load and running distance over complete
 *   weeks, each with how it changed and Progress's verdict: a real trend or normal variation.
 *
 * Every figure is the dashboards' own (M6's engine, services/analytics), with the catalogue's
 * context (about: metric id, kind, definition, caveat) and the Progress view it is on (dashboard).
 *
 * Too little data is a result (status insufficient_data, saying what is missing), never a zero,
 * so someone else's ownerId reads insufficient_data. A week after this one, or a trend window
 * out of range, is INVALID_INPUT.
 *
 * A record's source keeps its id and date but not its stored title (untitled): a title is the
 * owner's free text, which reaches the model only as untrusted_text. A period's label is code's.
 *
 * A heavy week or a long trend window can cite more records than one result holds: then every
 * figure keeps its period and fewer of its newest records (fitSources), and says truncated.
 */
import * as z from 'zod/mini';
import { mondayOf, type IsoDate } from '../../../domain/calendar.ts';
import { METRIC_IDS, type MetricId } from '../../../domain/analytics/metrics.ts';
import { TREND_METHOD } from '../../../domain/analytics/trend.ts';
import type { AvailabilityUnit } from '../../../domain/analytics/types.ts';
import { METHOD_MAX } from '../../../domain/coach/answer.ts';
import { TURN_LIMITS } from '../../../domain/coach/budgets.ts';
import type { SourceRef } from '../../../domain/coach/sources.ts';
import { canonicalJson } from '../../../domain/programming/random.ts';
import { MUSCLE_GROUPS, type MuscleGroup } from '../../../domain/training/vocabulary.ts';
import {
	getPerformanceTrends,
	getTrainingLoad,
	getWeeklyTrainingSummary,
	MAX_TREND_WEEKS,
	MIN_TREND_WEEKS,
	SOURCES_MAX,
	TREND_WEEKS
} from '../../services/analytics/index.ts';
import type { ResolvedCoachDeps } from '../../services/coach/shared.ts';
import type { ToolContext } from './context.ts';
import { defineTool, type CoachTool } from './define.ts';
import { sourceRefSchema } from './output.ts';

type Ctx = ToolContext<ResolvedCoachDeps>;
const training = (ctx: Ctx) => ({ db: ctx.deps.db });

const AVAILABILITY_UNITS = [
	'days',
	'weeks',
	'sessions',
	'runs',
	'sets',
	'points'
] as const satisfies readonly AvailabilityUnit[];
const TREND_METRICS = ['sessions', 'minutes', 'session_load', 'running_distance'] as const;

const isoDate = z.iso.date();
const truncated = z.optional(z.literal(true));
const method = z.string().check(z.minLength(1), z.maxLength(METHOD_MAX));
const sources = z.array(sourceRefSchema).check(z.minLength(1), z.maxLength(SOURCES_MAX + 1));
/** A figure's catalogue context (services/analytics' About). */
export const aboutSchema = z.object({
	metric: z.enum(METRIC_IDS as [MetricId, ...MetricId[]]),
	kind: z.enum(['measured', 'estimated', 'calculated', 'reported']),
	definition: z.string(),
	caveat: z.optional(z.string())
});
const about = aboutSchema;
/** The Progress page a figure is on. */
export const dashboardSchema = z.string().check(z.startsWith('/progress'));
const dashboard = dashboardSchema;
const figure = z.object({
	value: z.number(),
	unit: z.nullable(z.string()),
	method,
	sources,
	about
});
const verdict = z.enum(['real_trend', 'normal_variation', 'insufficient_data']);
/** A dashboard's verdict on a trend (services/analytics' TrendCall). */
export const trendCallShape = {
	verdict,
	realTrend: z.nullable(
		z.object({ direction: z.enum(['up', 'down']), good: z.nullable(z.boolean()) })
	),
	window: z.nullable(z.object({ from: isoDate, to: isoDate, label: z.string() })),
	classifier: z.literal(TREND_METHOD)
};
const groupValues = z.object(
	Object.fromEntries(MUSCLE_GROUPS.map((group) => [group, z.optional(z.number())])) as Record<
		MuscleGroup,
		z.ZodMiniOptional<z.ZodMiniNumber>
	>
);
const insufficient = z.object({
	status: z.literal('insufficient_data'),
	reason: z.enum(['no_training', 'too_little_history', 'no_rated_sessions']),
	have: z.number(),
	need: z.number(),
	unit: z.enum(AVAILABILITY_UNITS)
});

/** True when `value` fits one tool result. */
const fits = (value: unknown) =>
	new TextEncoder().encode(canonicalJson(value)).length <= TURN_LIMITS.toolOutputBytes;

/** `value` with every figure's sources replaced by `edit` of them. */
function mapSources(value: unknown, edit: (sources: SourceRef[]) => SourceRef[]): unknown {
	if (Array.isArray(value)) return value.map((item) => mapSources(item, edit));
	if (!value || typeof value !== 'object') return value;
	const mapped = Object.fromEntries(
		Object.entries(value).map(([key, child]) => [key, mapSources(child, edit)])
	);
	if ('method' in value && Array.isArray(mapped.sources)) mapped.sources = edit(mapped.sources);
	return mapped;
}

/** `value` with every figure's sources cut to its period and its `keep` newest records. */
const trimSources = (value: unknown, keep: number) =>
	mapSources(value, (sources) => sources.slice(0, 1 + keep));

function untitledRef(ref: SourceRef): SourceRef {
	if (ref.type === 'date') return ref;
	const { label: _title, ...rest } = ref;
	return rest;
}

/** `result` with no record's stored title in its sources: only a period keeps its label. */
export const untitled = <T extends object>(result: T): T =>
	mapSources(result, (sources) => sources.map(untitledRef)) as T;

/**
 * Decision: a result over the output cap keeps every figure and cites fewer records for each,
 * newest first, rather than losing figures; it says truncated. capOutput still has the last word.
 */
export function fitSources<T extends object>(result: T): T {
	if (fits(result)) return result;
	let shorter = result;
	for (let keep = SOURCES_MAX - 1; keep >= 0; keep -= 1) {
		shorter = { ...(trimSources(result, keep) as T), truncated: true };
		if (fits(shorter)) break;
	}
	return shorter;
}

// ---- get_weekly_training_summary ----------------------------------------------------------

const weeklyOutput = z.union([
	z.object({
		status: z.literal('ok'),
		week: z.object({ from: isoDate, to: isoDate, inProgress: z.boolean(), through: isoDate }),
		planned: figure,
		completed: figure,
		skipped: figure,
		workouts: figure,
		minutes: figure,
		sessionLoad: figure,
		unrated: figure,
		runningDistance: figure,
		hardSets: z.object({
			values: groupValues,
			unit: z.nullable(z.string()),
			method,
			sources,
			about
		}),
		dashboard,
		truncated
	}),
	insufficient
]);

const getWeeklyTrainingSummaryTool = defineTool({
	name: 'get_weekly_training_summary',
	description:
		"One Monday-to-Sunday week of the owner's training, computed by code: sessions planned, completed and skipped; workouts done; minutes; sRPE session load; workouts with no load; running distance; and hard sets per muscle group. Each figure has its value, unit, method (put it in the [metric method=…] tag) and sources (the week's date first, then its records, newest first). Leave week out for this week (in progress through today), or give any date in an earlier week. status insufficient_data means nothing was planned or logged that week: say so, never a zero.",
	input: z.object({ week: z.optional(isoDate) }),
	output: weeklyOutput,
	run: async ({ week }, ctx: Ctx) => {
		const monday = week === undefined ? undefined : mondayOf(week as IsoDate);
		const summary = await getWeeklyTrainingSummary(
			ctx.ownerId,
			{ today: ctx.today as IsoDate, week: monday },
			training(ctx)
		);
		return fitSources(untitled(summary));
	}
});

// ---- get_training_load ---------------------------------------------------------------------

const loadOutput = z.union([
	z.object({
		status: z.literal('ok'),
		from: isoDate,
		to: isoDate,
		days: z.int(),
		acute: figure,
		chronic: figure,
		ratio: figure,
		zone: z.nullable(z.enum(['low', 'typical', 'raised', 'sharp'])),
		last7Days: figure,
		unrated: figure,
		caveat: z.string(),
		dashboard,
		truncated
	}),
	insufficient
]);

const getTrainingLoadTool = defineTool({
	name: 'get_training_load',
	description:
		"The owner's training load as of today, computed by code from the sRPE load (minutes × session RPE) of completed workouts: the 7-day acute and 28-day chronic weighted averages, their acute:chronic ratio, and the last 7 days' total. Each figure has its value, unit, method and sources. Always give the ratio with its caveat: it is a rough guide, not an injury predictor. status insufficient_data means under 28 days of history or no rated workouts: say so.",
	input: z.object({}),
	output: loadOutput,
	run: async (_input, ctx: Ctx) =>
		fitSources(
			untitled(await getTrainingLoad(ctx.ownerId, { today: ctx.today as IsoDate }, training(ctx)))
		)
});

// ---- get_performance_trends ----------------------------------------------------------------

const pointSchema = z.object({
	at: isoDate,
	value: z.nullable(z.number()),
	inProgress: z.boolean()
});
const changeSchema = z.union([
	z.object({ enoughData: z.literal(false), points: z.int(), need: z.int(), verdict }),
	z.object({
		enoughData: z.literal(true),
		verdict,
		points: z.int(),
		from: isoDate,
		to: isoDate,
		earlier: z.number(),
		later: z.number(),
		delta: z.number(),
		pct: z.nullable(z.number()),
		direction: z.enum(['up', 'down', 'flat'])
	})
]);
const trendsOutput = z.union([
	z.object({
		status: z.literal('ok'),
		weeks: z.object({ from: isoDate, to: isoDate, count: z.int() }),
		trends: z.array(
			z.object({
				metric: z.enum(TREND_METRICS),
				unit: z.nullable(z.string()),
				method,
				sources,
				points: z.array(pointSchema).check(z.maxLength(MAX_TREND_WEEKS)),
				change: changeSchema,
				changeMethod: method,
				about,
				realTrend: trendCallShape.realTrend
			})
		),
		window: trendCallShape.window,
		classifier: trendCallShape.classifier,
		dashboard,
		truncated
	}),
	insufficient
]);

const getPerformanceTrendsTool = defineTool({
	name: 'get_performance_trends',
	description: `How the owner's training moved over complete weeks (this week is left out until it ends), computed by code: completed workouts, minutes, sRPE load and running distance per week, oldest first, from the first week with anything logged. Each trend has its unit, method, sources, weekly points and change: the later half's mean against the earlier half's (changeMethod; enoughData false means too few weeks to say), and change.verdict, the one Progress shows, judged over window (at least 12 weeks, named in window.label): real_trend (realTrend says which way, and good whether that is better), normal_variation, or insufficient_data for too few weeks to tell. Call a change a real trend or normal variation only as change.verdict says. ${TREND_WEEKS} weeks unless weeks says otherwise. status insufficient_data means nothing was logged in them.`,
	input: z.object({
		weeks: z.optional(z.int().check(z.minimum(MIN_TREND_WEEKS), z.maximum(MAX_TREND_WEEKS)))
	}),
	output: trendsOutput,
	run: async ({ weeks }, ctx: Ctx) =>
		fitSources(
			untitled(
				await getPerformanceTrends(
					ctx.ownerId,
					{ today: ctx.today as IsoDate, ...(weeks !== undefined && { weeks }) },
					training(ctx)
				)
			)
		)
});

/** Sorted by name, as every request lists tools. */
export const ANALYTICS_TOOLS: readonly CoachTool[] = [
	getPerformanceTrendsTool,
	getTrainingLoadTool,
	getWeeklyTrainingSummaryTool
];
