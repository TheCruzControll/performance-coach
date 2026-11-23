/**
 * The coach's weight read (the weight plan's PR 7): get_body_weight gives the owner's trend, rate,
 * 30-day stats, the newest weigh-ins and the active goal with its milestones. Code computes all of
 * it (services/weight getWeightFacts, over domain/analytics), in the owner's unit (kg or lb).
 *
 * A recorded weigh-in is a fact with its source. A computed figure (the trend, a rate, a change,
 * the goal's gap, rate and progress) is a metric with its method and the weigh-ins it rests on, so
 * an answer's [metric method=…] repeats the method and cites them, as the analytics tools do.
 *
 * A change is never signed. Its size is `value` (or `amount`, in a log row) and its `direction` is
 * up, down or flat, so the answer says "down 0.4 kg a week" and the grounding check, which reads
 * the number as written, finds the 0.4 the tool returned.
 *
 * Too little data is a result: with no weigh-in at all the status is insufficient_data, never a
 * zero. A goal whose start has no weigh-in around it reads verdict no_data.
 *
 * Nothing stored here is free text (a weigh-in has no note and a goal has no name), so no value
 * travels as untrusted_text. Every read is scoped to the session's owner.
 */
import * as z from 'zod/mini';
import { MILESTONES_MAX, type MilestoneReading } from '../../../domain/analytics/weight-goal.ts';
import type { IsoDate } from '../../../domain/calendar.ts';
import type { SourceRef } from '../../../domain/coach/sources.ts';
import type { WeightUnit } from '../../../domain/units.ts';
import type { ResolvedCoachDeps } from '../../services/coach/shared.ts';
import {
	FACTS_LOG_ROWS,
	FACTS_STATS_DAYS,
	getWeightFacts,
	type WeightFacts,
	type WeightGoalView
} from '../../services/weight/index.ts';
import type { ToolContext } from './context.ts';
import { defineTool, type CoachTool } from './define.ts';
import { metric, metricSchema, sourceRefSchema } from './output.ts';

type Ctx = ToolContext<ResolvedCoachDeps>;

const day = z.iso.date();
const direction = z.enum(['up', 'down', 'flat']);
const nullableMetric = z.nullable(metricSchema);
/** A computed change: its size, its unit and method, the weigh-ins it rests on, and its direction. */
const movementSchema = z.object({
	value: z.number(),
	unit: z.nullable(z.string()),
	method: z.string(),
	sources: z.array(sourceRefSchema),
	direction
});
const nullableMovement = z.nullable(movementSchema);
/** A change between two weigh-ins in a log row: its size and direction, no method of its own. */
const stepSchema = z.object({ amount: z.number(), direction });
const verdict = z.enum(['on_track', 'ahead', 'behind', 'no_data']);
const milestoneState = z.enum(['hit', 'missed', 'ahead', 'on_track', 'behind', 'no_data']);

/** A recorded weigh-in, in the owner's unit, with the source that opens it. */
const weighInSchema = z.object({ day, weight: z.number(), source: sourceRefSchema });
const logRowSchema = z.object({
	day,
	weight: z.number(),
	trend: z.number(),
	change: z.nullable(stepSchema),
	weeklyRate: z.nullable(stepSchema),
	source: sourceRefSchema
});
const goalSchema = z.object({
	direction: z.enum(['loss', 'gain', 'maintain']),
	startOn: day,
	startWeight: z.number(),
	targetOn: day,
	targetWeight: z.number(),
	/** ahead: the trend is further toward the target than the goal line; no_data: too few weigh-ins. */
	verdict,
	gap: nullableMetric,
	requiredRate: nullableMovement,
	actualRate: nullableMovement,
	percentDone: nullableMetric,
	distanceLeft: nullableMetric,
	daysLeft: z.nullable(z.int()),
	nextMilestone: z.nullable(z.object({ day, weight: z.number() })),
	stale: z.nullable(z.boolean()),
	milestones: z
		.array(z.object({ day, weight: z.number(), status: milestoneState }))
		.check(z.maxLength(MILESTONES_MAX)),
	source: sourceRefSchema
});
const weightOutput = z.union([
	z.object({
		status: z.literal('ok'),
		unit: z.enum(['kg', 'lb']),
		today: day,
		/** The newest weigh-in on or before today. */
		latest: weighInSchema,
		/** The trend today; `stale` once the newest weigh-in is more than a week old. */
		trend: metricSchema,
		stale: z.boolean(),
		/** The trend's change per week over the last 28 days; null with too little data. */
		weeklyRate: nullableMovement,
		stats: z.object({
			days: z.int(),
			highest: z.nullable(weighInSchema),
			lowest: z.nullable(weighInSchema),
			change: nullableMovement
		}),
		logBook: z.array(logRowSchema).check(z.maxLength(FACTS_LOG_ROWS)),
		goal: z.nullable(goalSchema),
		/** capOutput may shorten the log book (a top-level list) past the 8 KB cap. */
		truncated: z.optional(z.literal(true))
	}),
	z.object({ status: z.literal('insufficient_data'), reason: z.literal('no_weigh_ins') })
]);

/**
 * A weigh-in's source: its id is its day. No label or date, so a weigh-in ref stays short (the
 * worst case, 14 log rows and 24 milestones, is well under the output cap).
 */
const weighIn = (on: IsoDate): SourceRef => ({ type: 'weight', id: on });
/** The active goal's source: its id is the goal's, and it reads as a weight goal. */
const goalSource = (id: string): SourceRef => ({
	type: 'weight_goal',
	id,
	label: 'Weight goal'
});

/** Which way a change went; a change of nothing is flat. */
const directionOf = (change: number): 'up' | 'down' | 'flat' =>
	change > 0 ? 'up' : change < 0 ? 'down' : 'flat';
/** A change as its size and direction, for a log row. */
const step = (change: number) => ({ amount: Math.abs(change), direction: directionOf(change) });

/** The methods the answer repeats, each in the owner's unit (no brackets: the answer grammar). */
const method = {
	trend: (unit: WeightUnit) =>
		`Smoothed trend: each day moves a tenth of the way from the trend to that day’s weigh-in, in ${unit}`,
	rate: (unit: WeightUnit) =>
		`Slope of the trend over the last 28 days, times 7, the change per week in ${unit}`,
	change: (unit: WeightUnit) =>
		`Trend at the end of the last 30 days minus the trend at their start, in ${unit}`,
	gap: (unit: WeightUnit) => `Distance between today’s trend and the goal line today, in ${unit}`,
	required: (unit: WeightUnit) =>
		`Change per week from today’s trend that reaches the target by its day, in ${unit}`,
	actual: (unit: WeightUnit) => `Trend’s change per week over the last 28 days, in ${unit}`,
	percent: 'Progress from the start weight toward the target, judged on today’s trend',
	left: (unit: WeightUnit) => `Distance from today’s trend to the target weight, in ${unit}`
};

/** A figure in `unit` that the method computed, from the sources it rests on. */
const figure = (value: number, unit: string, text: string, sources: SourceRef[]) =>
	metric({ value, unit, method: text, sources });
/** A change: its size as a figure, with the direction it went. */
const movement = (change: number, unit: WeightUnit, text: string, sources: SourceRef[]) => ({
	...figure(Math.abs(change), unit, text, sources),
	direction: directionOf(change)
});

function milestoneOutput({ day, weight, status }: MilestoneReading) {
	return { day, weight, status };
}

function goalOutput(goal: WeightGoalView, unit: WeightUnit, newest: SourceRef) {
	const { status } = goal;
	const sources = [goalSource(goal.id), newest];
	const base = {
		direction: goal.direction,
		startOn: goal.startOn,
		startWeight: goal.startWeight,
		targetOn: goal.targetOn,
		targetWeight: goal.targetWeight,
		milestones: goal.milestones.map(milestoneOutput),
		source: goalSource(goal.id)
	};
	if (status.verdict === 'no_data') {
		return {
			...base,
			verdict: 'no_data' as const,
			gap: null,
			requiredRate: null,
			actualRate: null,
			percentDone: null,
			distanceLeft: null,
			daysLeft: null,
			nextMilestone: null,
			stale: null
		};
	}
	return {
		...base,
		verdict: status.verdict,
		gap: figure(status.gap, unit, method.gap(unit), sources),
		requiredRate:
			status.requiredRate === null
				? null
				: movement(status.requiredRate, unit, method.required(unit), sources),
		actualRate:
			status.actualRate === null
				? null
				: movement(status.actualRate, unit, method.actual(unit), sources),
		percentDone: figure(status.percentDone, '%', method.percent, sources),
		distanceLeft: figure(status.distanceLeft, unit, method.left(unit), sources),
		daysLeft: status.daysLeft,
		nextMilestone: status.nextMilestone
			? { day: status.nextMilestone.day, weight: status.nextMilestone.weight }
			: null,
		stale: status.stale
	};
}

/** The tool's output for a read of the owner's weight facts. */
export function weightOutputOf(facts: WeightFacts) {
	const { unit, today, latest, trend, stale, weeklyRate, stats, logBook, goal } = facts;
	if (latest === null || trend === null)
		return { status: 'insufficient_data' as const, reason: 'no_weigh_ins' as const };
	const newest = weighIn(latest.day);
	const weighInOf = (point: { day: IsoDate; weight: number }) => ({
		day: point.day,
		weight: point.weight,
		source: weighIn(point.day)
	});
	return {
		status: 'ok' as const,
		unit,
		today,
		latest: weighInOf(latest),
		trend: figure(trend, unit, method.trend(unit), [newest]),
		stale,
		weeklyRate:
			weeklyRate === null ? null : movement(weeklyRate, unit, method.rate(unit), [newest]),
		stats: {
			days: FACTS_STATS_DAYS,
			highest: stats.highest ? weighInOf(stats.highest) : null,
			lowest: stats.lowest ? weighInOf(stats.lowest) : null,
			change:
				stats.change === null ? null : movement(stats.change, unit, method.change(unit), [newest])
		},
		logBook: logBook.map((row) => ({
			day: row.day,
			weight: row.weight,
			trend: row.trend,
			change: row.change === null ? null : step(row.change),
			weeklyRate: row.weeklyRate === null ? null : step(row.weeklyRate),
			source: weighIn(row.day)
		})),
		goal: goal ? goalOutput(goal, unit, newest) : null
	};
}

const getBodyWeightTool = defineTool({
	name: 'get_body_weight',
	description:
		"The owner's body weight, computed by code in their unit (kg or lb): the smoothed trend (each day moves a tenth of the way toward that day's weigh-in, so one odd day barely moves it), the newest weigh-in, whether the trend is stale (no weigh-in for over a week), the trend's change per week over 28 days, the highest, lowest and the change over the last 30 days, the newest 14 weigh-ins with their trend and change, and the active goal: its direction, start, target and target day, the verdict today (on_track; ahead when the trend is further toward the target than the goal line; behind when it is not; each within a tolerance; no_data with too few weigh-ins), the gap to the goal line, the change per week needed and achieved, percent done, distance and days left, the next milestone and every milestone with its status (hit, missed, ahead, on_track, behind, no_data). A change is given as its size, never signed, and its direction (up, down or flat): say it in words, such as 'down 0.4 kg a week', never with a minus sign. A computed figure has its value, unit, method (put it in the [metric method=…] tag) and sources; a recorded weigh-in is a fact with its source. Say a rate or a verdict only as the output states it, and never state a figure that is null. status insufficient_data means no weigh-in has been logged: say so, never a zero.",
	input: z.object({}),
	output: weightOutput,
	run: async (_input, ctx: Ctx) =>
		weightOutputOf(await getWeightFacts(ctx.ownerId, ctx.today as IsoDate, { db: ctx.deps.db }))
});

/** Sorted by name, as every request lists tools. */
export const WEIGHT_TOOLS: readonly CoachTool[] = [getBodyWeightTool];
