/**
 * Program reads (PRD §5, §7; ADR 0010): what Train, Today, the session screen and the coach's
 * get_current_program and get_current_training_week tools (M5) read.
 * - Each reads the owner's active program, at its current version unless a number is given.
 * - Dates are explicit: routes pass the owner's today (ownerToday, m3/27). No read looks at the
 *   clock.
 * - Status is derived: a session reads 'completed' once a completed, undeleted workout has been
 *   logged against its lineage. The planned rows never change, and the status holds in every
 *   later version.
 * - The states screens design are explicit: a week beyond the planned weeks is planned: false,
 *   with the outline phase there; a program that has not started gives its first planned day;
 *   and blockComplete says the planned weeks are over, until M6 plans the next block.
 */
import { addDays, mondayOf, parseIsoDate, weekdayOf, type IsoDate } from '../../../domain/calendar';
import type { ProfileDistanceUnit } from '../../../domain/profile/types';
import { BRIDGE_PHASE, BRIDGE_WEEK_KIND } from '../../../domain/programming/next-block/dates';
import { describeSession, type SessionLineOptions } from '../../../domain/training/describe';
import type {
	ExerciseRef,
	OtherDetails,
	ProgramSummary,
	RunSegment,
	SessionView,
	VersionInfo,
	WeekTargets,
	WeekView
} from '../../../domain/training/types';
import type { Phase, WeekKind } from '../../../domain/training/vocabulary';
import { createProfileRepository } from '../../db/repositories/profile';
import {
	createProgramsRepository,
	type SessionLineRows,
	type VersionOutlineRows,
	type VersionRow
} from '../../db/repositories/programs';
import type { Executor } from '../../db/types';
import { measure } from '../../observability/timing';
import { isUuid } from '../ids';
import {
	resolveDeps,
	TrainingInputError,
	TrainingNotFoundError,
	type TrainingDeps
} from '../training/shared';
import { refOf, toStoredSessions, type StoredExercise } from './mapping';
import { MAX_VERSION } from './store';

/** How many sessions Today's 'Up next' lists: the next ones after today, across weeks. */
export const UP_NEXT_LIMIT = 3;

/** The furthest week an index may name, well past any plan (12 blocks of up to 52 weeks). */
const MAX_WEEK_INDEX = 1000;

/** athlete_profiles' own default, for an owner who has no profile row yet. */
const DEFAULT_DISTANCE_UNIT: ProfileDistanceUnit = 'km';

export interface CurrentProgram extends ProgramSummary {
	/** The planned week today falls in, n of plannedWeeks: 1 until the start, null once over. */
	currentWeek: number | null;
	/** That week establishes baselines: its RPE-based sets give each lift's estimated 1RM. */
	baseline: boolean;
	/** Today is before firstPlannedDay. */
	notStarted: boolean;
	/** Today is after lastPlannedDay: only outline weeks are left, until M6 plans the next block. */
	blockComplete: boolean;
}

/**
 * A week by a date in it, or by its block's position and its week in that block, both from 1.
 * Weeks count on from the block's first, past its end too, so {block: 1, week: n} is the
 * program's week n.
 */
export type WeekAt = { date: IsoDate } | { block: number; week: number };

export interface ReadOptions {
	/** One of the active program's version numbers; its current version when left out. */
	version?: number;
}

export type TrainingWeek = WeekView & {
	version: VersionInfo;
	/** firstPlannedDay, when the date asked for is before it: the week given is week 1. */
	programStartsOn?: IsoDate;
	/**
	 * In a bridge week (an unplanned week of a 'Between blocks' block, next-block/dates.ts): the
	 * day the next block starts, the day after the bridge ends.
	 */
	nextBlockStartsOn?: IsoDate;
};

/** A planned exercise with its name in the owner's library. */
export type SessionExercise = StoredExercise & { name: string };

/** The week a session is in, and its block. */
export interface SessionWeek {
	lineage: string;
	kind: WeekKind;
	phase: Phase;
	blockName: string;
	startsOn: IsoDate;
	endsOn: IsoDate;
}

/** One planned session in full, as the session screen and the coach read it. */
export type PlannedSession = Omit<SessionView, 'kind'> &
	(
		| { kind: 'strength'; exercises: SessionExercise[] }
		| { kind: 'run'; segments: RunSegment[] }
		| { kind: 'other'; details: OtherDetails }
	) & {
		/** Its row in the version read: what a workout logged from it names (M4). */
		id: string;
		estLoad: number;
		commitmentRef: string | null;
		instructions: string | null;
		notes: string | null;
		week: SessionWeek;
		version: VersionInfo;
		/** The current version still has it: false when only older versions do. */
		inCurrentVersion: boolean;
	};

export interface TodayPlan {
	/** Today's sessions in order; none on a rest day. */
	sessions: SessionView[];
	/** The next UP_NEXT_LIMIT sessions after today, across week boundaries. */
	upNext: SessionView[];
	/** firstPlannedDay, while today is before it. */
	startsOn?: IsoDate;
	/** Today is after lastPlannedDay: nothing is planned until M6 plans the next block. */
	blockComplete: boolean;
}

type ProgramsRepository = ReturnType<typeof createProgramsRepository>;
type BlockRow = VersionOutlineRows['blocks'][number];
type WeekRow = VersionOutlineRows['weeks'][number];

/** A planned week (of a planned block), with its block and its number among planned weeks. */
interface PlannedWeek {
	row: WeekRow;
	block: BlockRow;
	number: number;
}

interface Outline {
	/** By position: the planned blocks, then the outline. */
	blocks: BlockRow[];
	planned: PlannedWeek[];
	/** The last planned week's Sunday. */
	lastPlannedDay: IsoDate;
}

function outlineOf({ blocks, weeks }: VersionOutlineRows): Outline {
	const blockOf = new Map(blocks.map((block) => [block.id, block]));
	const planned = weeks
		.map((row) => ({ row, block: blockOf.get(row.blockId)! }))
		.filter(({ block }) => !block.outline)
		.map((week, i) => ({ ...week, number: i + 1 }));
	// programPlanSchema: the first block is planned, and its weeks fill it.
	return { blocks, planned, lastPlannedDay: planned.at(-1)!.row.endsOn };
}

/** The planned week `date` falls in: week 1 before the start, none after lastPlannedDay. */
function plannedWeekOn({ planned }: Outline, date: IsoDate): PlannedWeek | null {
	if (date < planned[0]!.row.startsOn) return planned[0]!;
	return planned.find(({ row }) => row.startsOn <= date && date <= row.endsOn) ?? null;
}

/** The date a WeekAt names: its own, or `week - 1` weeks on from its block's first day. */
function dateOf({ blocks }: Outline, at: WeekAt): IsoDate {
	if ('date' in at) return at.date;
	const block = blocks.find((b) => b.position === at.block);
	if (!block) throw new TrainingNotFoundError('program week');
	return addDays(block.startsOn, 7 * (at.week - 1));
}

/** The phase of the outline block that holds `date`, if any. */
const outlinePhaseOn = (blocks: BlockRow[], date: IsoDate): Phase | null =>
	blocks.find((b) => b.outline && b.startsOn <= date && date <= b.endsOn)?.phase ?? null;

const versionInfo = ({ program, version }: VersionRow): VersionInfo => ({
	number: version.number,
	createdAt: version.createdAt,
	createdBy: version.createdBy,
	summary: version.summary,
	current: program.currentVersionId === version.id
});

function checkDate(field: string, value: unknown): IsoDate {
	if (typeof value === 'string' && parseIsoDate(value)) return value;
	throw new TrainingInputError({ [field]: 'Not a calendar date (YYYY-MM-DD)' });
}

/** A whole number from 1 to `max`. */
const isIndex = (n: unknown, max = Number.MAX_SAFE_INTEGER): n is number =>
	Number.isInteger(n) && (n as number) >= 1 && (n as number) <= max;

function checkWeekAt(at: WeekAt): WeekAt {
	if ('date' in at) return { date: checkDate('date', at.date) };
	const errors: Record<string, string> = {};
	if (!isIndex(at.block)) errors.block = 'A block number, from 1';
	if (!isIndex(at.week, MAX_WEEK_INDEX)) errors.week = `A week number, from 1 to ${MAX_WEEK_INDEX}`;
	if (Object.keys(errors).length > 0) throw new TrainingInputError(errors);
	return { block: at.block, week: at.week };
}

/** The active program at the version asked for: null with none, not found for an unknown one. */
async function readVersion(
	repo: ProgramsRepository,
	ownerId: string,
	version: number | undefined
): Promise<VersionRow | null> {
	if (version !== undefined && !isIndex(version, MAX_VERSION)) {
		throw new TrainingNotFoundError('program version');
	}
	const found = await repo.currentProgram(ownerId, version);
	if (!found && version !== undefined) throw new TrainingNotFoundError('program version');
	return found;
}

const refKey = (ref: ExerciseRef) => ('key' in ref ? `key:${ref.key}` : `custom:${ref.customId}`);

/**
 * The sessions as SessionViews, in the rows' order: each with its line in the owner's distance
 * unit and the library's names, and 'completed' when a completed workout matches its lineage.
 */
async function sessionViews(
	db: Executor,
	ownerId: string,
	rows: SessionLineRows
): Promise<SessionView[]> {
	if (!rows.sessions.length) return [];
	const completed = await createProgramsRepository(db).completedLineages(
		ownerId,
		rows.sessions.map((s) => s.lineageId)
	);
	const profile = await createProfileRepository(db).getProfile(ownerId);
	const names = new Map(
		rows.exercises.map((e) => [refKey(refOf(e.exerciseId, e.exerciseKey)), e.exerciseName])
	);
	const options: SessionLineOptions = {
		distanceUnit: profile?.distanceUnit ?? DEFAULT_DISTANCE_UNIT,
		exerciseName: (ref) => names.get(refKey(ref))!
	};
	return [...toStoredSessions(rows).values()].map((s) => ({
		lineage: s.lineage,
		kind: s.kind,
		date: s.date,
		timeOfDay: s.timeOfDay,
		orderInDay: s.orderInDay,
		type: s.type,
		title: s.title,
		discipline: s.discipline,
		customDiscipline: s.customDiscipline,
		intensity: s.intensity,
		estMinutes: s.estMinutes,
		targetRpe: s.targetRpe,
		source: s.source,
		status: completed.has(s.lineage) ? 'completed' : s.status,
		movedFrom: s.movedFrom,
		line: describeSession(s, options)
	}));
}

/**
 * The owner's active program at its current version, and where `today` falls in it; null when
 * there is none.
 */
export async function getCurrentProgram(
	ownerId: string,
	today: IsoDate,
	deps: TrainingDeps = {}
): Promise<CurrentProgram | null> {
	checkDate('today', today);
	const { db } = resolveDeps(deps);
	return measure('db', async () => {
		const repo = createProgramsRepository(db);
		const found = await repo.currentProgram(ownerId);
		if (!found) return null;
		const outline = outlineOf(await repo.versionOutline(found.version.id));
		const plannedIn = Map.groupBy(outline.planned, (week) => week.block.id);
		const blockComplete = today > outline.lastPlannedDay;
		const week = blockComplete ? null : plannedWeekOn(outline, today);
		const { program, version } = found;
		return {
			id: program.id,
			title: program.title,
			startsOn: version.startsOn,
			firstPlannedDay: version.firstPlannedDay,
			version: versionInfo(found),
			lastPlannedDay: outline.lastPlannedDay,
			plannedWeeks: outline.planned.length,
			blocks: outline.blocks.map((block) => ({
				lineage: block.lineageId,
				phase: block.phase,
				name: block.name,
				startsOn: block.startsOn,
				endsOn: block.endsOn,
				outline: block.outline,
				goalRefs: block.goalRefs,
				plannedWeeks: plannedIn.get(block.id)?.length ?? 0
			})),
			currentWeek: week?.number ?? null,
			baseline: week?.row.kind === 'baseline',
			notStarted: today < version.firstPlannedDay,
			blockComplete
		};
	});
}

/**
 * A Monday-to-Sunday week of the active program, with each day's sessions; null when there is
 * no active program. A date before the start gives week 1, and a week past the planned weeks
 * gives planned: false, with the outline phase there or null.
 */
export async function getTrainingWeek(
	ownerId: string,
	at: WeekAt,
	{ version }: ReadOptions = {},
	deps: TrainingDeps = {}
): Promise<TrainingWeek | null> {
	const wanted = checkWeekAt(at);
	const { db } = resolveDeps(deps);
	return measure('db', async () => {
		const repo = createProgramsRepository(db);
		const found = await readVersion(repo, ownerId, version);
		if (!found) return null;
		const outline = outlineOf(await repo.versionOutline(found.version.id));
		const date = dateOf(outline, wanted);
		const info = versionInfo(found);
		const week = plannedWeekOn(outline, date);
		if (!week) {
			const startsOn = mondayOf(date);
			return {
				planned: false,
				phase: outlinePhaseOn(outline.blocks, startsOn),
				startsOn,
				endsOn: addDays(startsOn, 6),
				version: info
			};
		}
		const sessions = await sessionViews(
			db,
			ownerId,
			await repo.sessionsWithChildren([week.row.id])
		);
		const { startsOn, endsOn, kind, lineageId, targets } = week.row;
		const { firstPlannedDay } = found.version;
		return {
			planned: true,
			lineage: lineageId,
			kind,
			startsOn,
			endsOn,
			targets: targets as unknown as WeekTargets,
			phase: week.block.phase,
			blockName: week.block.name,
			number: week.number,
			days: Array.from({ length: 7 }, (_, n) => {
				const day = addDays(startsOn, n);
				return {
					date: day,
					weekday: weekdayOf(day),
					sessions: sessions.filter((s) => s.date === day)
				};
			}),
			version: info,
			...(date < firstPlannedDay ? { programStartsOn: firstPlannedDay } : {}),
			...(kind === BRIDGE_WEEK_KIND && week.block.phase === BRIDGE_PHASE
				? { nextBlockStartsOn: addDays(week.block.endsOn, 1) }
				: {})
		};
	});
}

/**
 * One session of the active program by lineage, with its prescriptions, segments or details.
 * A malformed or unknown lineage, or an unknown version, is not found.
 */
export async function getPlannedSession(
	ownerId: string,
	lineage: string,
	{ version }: ReadOptions = {},
	deps: TrainingDeps = {}
): Promise<PlannedSession> {
	if (!isUuid(lineage)) throw new TrainingNotFoundError('planned session');
	const { db } = resolveDeps(deps);
	return measure('db', async () => {
		const repo = createProgramsRepository(db);
		const found = await readVersion(repo, ownerId, version);
		const hit = found && (await repo.sessionByLineage(found.version.id, lineage));
		if (!found || !hit) throw new TrainingNotFoundError('planned session');
		const rows = { sessions: [hit.session], ...(await repo.sessionChildren([hit.session.id])) };
		const [view] = await sessionViews(db, ownerId, rows);
		const stored = toStoredSessions(rows).get(hit.session.id)!;
		const info = versionInfo(found);
		const inCurrentVersion =
			info.current ||
			(await repo.sessionByLineage(found.program.currentVersionId!, lineage)) !== null;
		const names = new Map(rows.exercises.map((e) => [e.id, e.exerciseName]));
		const content =
			stored.kind === 'strength'
				? {
						kind: stored.kind,
						exercises: stored.exercises.map((e) => ({ ...e, name: names.get(e.id)! }))
					}
				: stored.kind === 'run'
					? { kind: stored.kind, segments: stored.segments }
					: { kind: stored.kind, details: stored.details };
		const { week, block } = hit;
		return {
			...view!,
			...content,
			id: stored.id,
			estLoad: stored.estLoad,
			commitmentRef: stored.commitmentRef,
			instructions: stored.instructions,
			notes: stored.notes,
			week: {
				lineage: week.lineageId,
				kind: week.kind,
				phase: block.phase,
				blockName: block.name,
				startsOn: week.startsOn,
				endsOn: week.endsOn
			},
			version: info,
			inCurrentVersion
		};
	});
}

/**
 * Today's sessions in the active program, the next ones after them, and whether the program
 * has started or its planned weeks are over; null when there is no active program.
 */
export async function getTodayPlan(
	ownerId: string,
	today: IsoDate,
	deps: TrainingDeps = {}
): Promise<TodayPlan | null> {
	checkDate('today', today);
	const { db } = resolveDeps(deps);
	return measure('db', async () => {
		const repo = createProgramsRepository(db);
		const found = await repo.currentProgram(ownerId);
		if (!found) return null;
		const { id: versionId, firstPlannedDay } = found.version;
		const { lastPlannedDay } = outlineOf(await repo.versionOutline(versionId));
		const todays = await repo.plannedSessionsInRange(versionId, today, today);
		const next = await repo.upcomingSessions(versionId, today, UP_NEXT_LIMIT);
		const sessions = [...todays, ...next];
		const children = await repo.lineChildren(sessions.map((s) => s.id));
		const views = await sessionViews(db, ownerId, { sessions, ...children });
		return {
			sessions: views.slice(0, todays.length),
			upNext: views.slice(todays.length),
			...(today < firstPlannedDay ? { startsOn: firstPlannedDay } : {}),
			blockComplete: today > lastPlannedDay
		};
	});
}
