/**
 * The reads behind the Weight view, Today's card, the coach and the weekly review. Each one loads
 * the owner's weigh-ins up to today, the active goal with its milestones, and (for the view) the
 * goal history, then hands them to the figures in domain/analytics (weight.ts, weight-goal.ts).
 * Read-only: nothing is written, and a missing profile reads as the defaults (kg, UTC).
 *
 * The trend is computed over every weigh-in the owner has and only then cut to the window, so a
 * period's first point is the trend the whole history gives. Every figure is in the owner's unit.
 * Every read is scoped to the owner.
 */
import {
	dailyTrend,
	logBook,
	trendOn,
	weeklyRate,
	weeklyRateBars,
	weightStats,
	type LogRow,
	type RateBar,
	type Reading,
	type TrendDay,
	type WeighIn,
	type WeightStats
} from '../../../domain/analytics/weight';
import {
	ACTUAL_RATE_DAYS,
	directionOf,
	goalLine,
	goalStatus,
	milestoneStatus,
	type Direction,
	type GoalStatus,
	type Milestone,
	type MilestoneReading,
	type WeightGoal
} from '../../../domain/analytics/weight-goal';
import { periodWindow, type Period } from '../../../domain/analytics/periods';
import { addDays, type IsoDate } from '../../../domain/calendar';
import type { WeightSource } from '../../../domain/profile/catalog';
import { cleanFloat, convertWeight, type WeightUnit } from '../../../domain/units';
import {
	createProfileRepository,
	createWeightRepository,
	getDb,
	type Executor,
	type WeightEntryRow,
	type WeightGoalEndReason,
	type WeightGoalRow,
	type WeightGoalStatus,
	type WeightMilestoneRow
} from '../../db';
import { measure } from '../../observability/timing';

export interface WeightReadDeps {
	db?: Executor;
}

/** The Weight view's stats: 30 days, for the coach's facts. */
export const FACTS_STATS_DAYS = 30;
/** The coach's facts list this many newest log rows. */
export const FACTS_LOG_ROWS = 14;

/** A figure in the owner's unit, rounded for display (as the domain rounds its own). */
const shown = (value: number, from: WeightUnit, to: WeightUnit): number =>
	cleanFloat(convertWeight(value, from, to), 2) + 0;

/** A goal in `unit`, its weights converted and not rounded, as the goal functions convert them. */
function goalIn(goal: WeightGoal, unit: WeightUnit): WeightGoal {
	return {
		...goal,
		unit,
		startWeight: convertWeight(goal.startWeight, goal.unit, unit),
		targetWeight: convertWeight(goal.targetWeight, goal.unit, unit)
	};
}

function goalOf(row: WeightGoalRow): WeightGoal {
	return {
		unit: row.unit,
		startOn: row.startOn,
		startWeight: row.startWeight,
		targetOn: row.targetOn,
		targetWeight: row.targetWeight
	};
}

function milestonesOf(rows: WeightMilestoneRow[]): Milestone[] {
	return rows.map((row) => ({ day: row.onDate, weight: row.weight }));
}

/** Everything the reads start from, loaded once per call. */
interface Loaded {
	unit: WeightUnit;
	/** Every weigh-in up to today, oldest first. */
	rows: WeightEntryRow[];
	weighIns: WeighIn[];
	/** The trend series over every weigh-in (dailyTrend). */
	series: TrendDay[];
	goal: WeightGoalRow | null;
	milestones: WeightMilestoneRow[];
}

async function load(db: Executor, ownerId: string, today: IsoDate): Promise<Loaded> {
	const profile = await createProfileRepository(db).getProfile(ownerId);
	const unit: WeightUnit = profile?.weightUnit ?? 'kg';
	const repo = createWeightRepository(db);
	const rows = await repo.listRange(ownerId, null, today);
	const weighIns = rows.map(({ measuredOn, value, unit: from }) => ({
		measuredOn,
		value,
		unit: from
	}));
	const goal = await repo.getActiveGoal(ownerId);
	const milestones = goal ? await repo.listMilestones(ownerId, goal.id) : [];
	return { unit, rows, weighIns, series: dailyTrend(weighIns, unit), goal, milestones };
}

/** The first day a period shows (Progress's own window, so the Monday is the same); null for All. */
export function windowFrom(period: Period, today: IsoDate): IsoDate | null {
	if (period === 'all') return null;
	return periodWindow(today, period, null).weeks?.from ?? today;
}

/** The goal as the screens show it: its figures in the owner's unit, and its status and milestones. */
export interface WeightGoalView {
	id: string;
	direction: Direction;
	startOn: IsoDate;
	startWeight: number;
	targetOn: IsoDate;
	targetWeight: number;
	/** Today against the trend and the line (weight-goal.ts), in the owner's unit. */
	status: GoalStatus;
	/** Each milestone with its state, in the owner's unit, oldest first. */
	milestones: MilestoneReading[];
}

function goalViewOf(loaded: Loaded, row: WeightGoalRow, today: IsoDate): WeightGoalView {
	const goal = goalOf(row);
	const unit = loaded.unit;
	const milestones = milestonesOf(loaded.milestones);
	return {
		id: row.id,
		direction: directionOf(goal),
		startOn: goal.startOn,
		startWeight: shown(goal.startWeight, goal.unit, unit),
		targetOn: goal.targetOn,
		targetWeight: shown(goal.targetWeight, goal.unit, unit),
		status: goalStatus(goal, loaded.series, today, unit, milestones),
		milestones: milestoneStatus(goal, milestones, loaded.series, today, unit)
	};
}

/** The goal line's points in the window: its start (or the window's first day) and its target day. */
function goalLineOf(goal: WeightGoal, unit: WeightUnit, from: IsoDate | null) {
	const line = goalIn(goal, unit);
	const first = from === null || from < goal.startOn ? goal.startOn : from;
	if (first > goal.targetOn) return [];
	return [first, goal.targetOn].map((day) => ({ day, weight: goalLine(line, day) }));
}

/** A goal in the history, its weights in the owner's unit. */
export interface WeightGoalSummary {
	id: string;
	status: WeightGoalStatus;
	endedReason: WeightGoalEndReason | null;
	endedAt: Date | null;
	startOn: IsoDate;
	startWeight: number;
	targetOn: IsoDate;
	targetWeight: number;
	createdAt: Date;
}

function summaryOf(row: WeightGoalRow, unit: WeightUnit): WeightGoalSummary {
	return {
		id: row.id,
		status: row.status,
		endedReason: row.endedReason,
		endedAt: row.endedAt,
		startOn: row.startOn,
		startWeight: shown(row.startWeight, row.unit, unit),
		targetOn: row.targetOn,
		targetWeight: shown(row.targetWeight, row.unit, unit),
		createdAt: row.createdAt
	};
}

export interface WeightView {
	period: Period;
	unit: WeightUnit;
	today: IsoDate;
	/** The window's first day; null for All. The window runs to today. */
	from: IsoDate | null;
	stats: WeightStats;
	/** The log book rows in the window, newest first. */
	logBook: LogRow[];
	/** One bar per week with data in the window, oldest first. */
	rateBars: RateBar[];
	chart: {
		/** The weigh-ins in the window (the dots). */
		weighIns: Reading[];
		/** The trend in the window (the line). */
		trend: { day: IsoDate; trend: number }[];
		/** The goal line's ends in the window, the target day included; empty without a goal. */
		goalLine: { day: IsoDate; weight: number }[];
	};
	goal: WeightGoalView | null;
	/** Every goal the owner has had, the active one first, then newest first. */
	goalHistory: WeightGoalSummary[];
}

/** The Weight view for a Progress period, as of `today` (the owner's calendar day). */
export async function getWeightView(
	ownerId: string,
	period: Period,
	today: IsoDate,
	deps: WeightReadDeps = {}
): Promise<WeightView> {
	const db = deps.db ?? getDb();
	const loaded = await measure('db', () => load(db, ownerId, today));
	const history = await measure('db', () => createWeightRepository(db).listGoals(ownerId));
	const from = windowFrom(period, today);
	const inWindow = (day: IsoDate) => from === null || day >= from;
	const { unit, series, goal } = loaded;
	return {
		period,
		unit,
		today,
		from,
		stats: weightStats(loaded.weighIns, unit, { from, to: today }),
		logBook: logBook(loaded.weighIns, unit).filter((row) => inWindow(row.day)),
		rateBars: weeklyRateBars(series, today).filter((bar) => from === null || bar.week >= from),
		chart: {
			weighIns: series
				.filter((point) => point.weight !== null && inWindow(point.day))
				.map((point) => ({ day: point.day, weight: point.weight! })),
			trend: series
				.filter((point) => inWindow(point.day))
				.map((point) => ({ day: point.day, trend: point.trend })),
			goalLine: goal ? goalLineOf(goalOf(goal), unit, from) : []
		},
		goal: goal ? goalViewOf(loaded, goal, today) : null,
		goalHistory: history
			.map((row) => summaryOf(row, unit))
			.sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active'))
	};
}

export interface WeightToday {
	unit: WeightUnit;
	today: IsoDate;
	/** The weigh-in for today, in the owner's unit; null when there is none yet. */
	entry: { id: number; weight: number; source: WeightSource } | null;
	/** The latest weigh-in, on or before today. */
	latest: Reading | null;
	/** The trend today (null with no weigh-in). */
	trend: number | null;
	/** The trend is more than STALE_DAYS old. */
	stale: boolean;
	/** The goal's verdict today; null without an active goal. */
	verdict: GoalStatus['verdict'] | null;
}

/** Today's card: today's weigh-in, the latest weigh-in, the trend and the goal's verdict. */
export async function getWeightToday(
	ownerId: string,
	today: IsoDate,
	deps: WeightReadDeps = {}
): Promise<WeightToday> {
	const db = deps.db ?? getDb();
	const loaded = await measure('db', () => load(db, ownerId, today));
	const { unit, rows, series } = loaded;
	const reading = trendOn(series, today);
	const last = rows[rows.length - 1];
	const verdict =
		loaded.goal === null
			? null
			: goalStatus(goalOf(loaded.goal), series, today, unit, milestonesOf(loaded.milestones))
					.verdict;
	const todays = rows.find((row) => row.measuredOn === today);
	return {
		unit,
		today,
		entry: todays
			? { id: todays.id, weight: shown(todays.value, todays.unit, unit), source: todays.source }
			: null,
		latest: last ? { day: last.measuredOn, weight: shown(last.value, last.unit, unit) } : null,
		trend: reading?.trend ?? null,
		stale: reading?.stale ?? false,
		verdict
	};
}

export interface WeightFacts {
	unit: WeightUnit;
	today: IsoDate;
	latest: Reading | null;
	trend: number | null;
	stale: boolean;
	/** The trend's weekly rate over the last ACTUAL_RATE_DAYS days. */
	weeklyRate: number | null;
	/** The stats over the last FACTS_STATS_DAYS days. */
	stats: WeightStats;
	/** The newest FACTS_LOG_ROWS log rows. */
	logBook: LogRow[];
	goal: WeightGoalView | null;
}

/** What the coach and the weekly review read: the trend, rate, stats, log rows and goal. */
export async function getWeightFacts(
	ownerId: string,
	today: IsoDate,
	deps: WeightReadDeps = {}
): Promise<WeightFacts> {
	const db = deps.db ?? getDb();
	const loaded = await measure('db', () => load(db, ownerId, today));
	const { unit, rows, series } = loaded;
	const reading = trendOn(series, today);
	const last = rows[rows.length - 1];
	const from = addDays(today, 1 - FACTS_STATS_DAYS);
	return {
		unit,
		today,
		latest: last ? { day: last.measuredOn, weight: shown(last.value, last.unit, unit) } : null,
		trend: reading?.trend ?? null,
		stale: reading?.stale ?? false,
		weeklyRate: weeklyRate(series, addDays(today, 1 - ACTUAL_RATE_DAYS), today),
		stats: weightStats(loaded.weighIns, unit, { from, to: today }),
		logBook: logBook(loaded.weighIns, unit).slice(0, FACTS_LOG_ROWS),
		goal: loaded.goal ? goalViewOf(loaded, loaded.goal, today) : null
	};
}
