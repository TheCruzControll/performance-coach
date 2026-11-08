/**
 * The owner's program edits (PRD §5, ADR 0010): move a planned session to another day of its
 * week or skip it; swap an exercise for one of its alternatives, once or never again; adjust a
 * strength set, a run segment or another session's details. Each is a revision (reviseProgram): a new version that copies the
 * session's week, with one decision whose 'why' is never empty, while every older version stays
 * as it was.
 *
 * - Only a session dated today or later can be edited, and only to a day from today on
 *   (reachableDates). A completed or skipped session cannot be moved or skipped. Each refusal is
 *   a field error, at `sessionLineage` or `toDate`.
 * - A move that breaks an interference rule goes ahead: BLOCKS_EDIT in domain/programming/
 *   interference.ts blocks no severity by default. The rules the move newly breaks are returned
 *   and written into the decision's 'why'; checkMove gives the same warnings before saving.
 * - getMoveTargets lists the days a move can reach, each with what is planned there, so the Move
 *   sheet offers only those, and none when no day is left.
 * - A swap offers only the exercise's alternatives (./alternatives.ts); 'never again' also saves
 *   a dislike in the same transaction. An adjustment is checked whole with its prescription's
 *   schema, and the session's estimate and load are worked out again.
 *
 * The checks read the version the edit was made on. Its rows never change, so what they find is
 * what reviseProgram copies; it then writes only if that version is still the current one.
 *
 * Each edit's body is an applier (moveApplier, skipApplier, swapApplier, setApplier,
 * runSegmentApplier, detailsApplier): it checks the edit and works it out as a PlannedEdit
 * without writing anything. Each exported edit revises with its one applier;
 * applyProgramEdits (./batch.ts) revises with several as one version.
 */
import { addDays, parseIsoDate, weekdayOf, type IsoDate } from '../../../domain/calendar';
import { TIMES_OF_DAY, WEEKDAY_INFO, type TimeOfDay } from '../../../domain/profile/catalog';
import { render, TEMPLATES } from '../../../domain/programming/decisions';
import { NO_REASON } from '../../../domain/programming/decisions/templates/edits';
import {
	BLOCKS_EDIT,
	checkWeek,
	type InterferenceRule,
	type Severity,
	type Violation
} from '../../../domain/programming/interference';
import { toExerciseKey } from '../../../domain/programming/input';
import { ASSUMED_EASY_PACE } from '../../../domain/programming/rules/running';
import { estimateMinutes } from '../../../domain/programming/timefit';
import { describePrescription, describeSegment } from '../../../domain/training/describe';
import {
	adjustDetailsSchema,
	adjustRunSegmentSchema,
	adjustSetSchema,
	moveSessionSchema,
	skipSessionSchema,
	swapSchema,
	type MoveSessionInput
} from '../../../domain/training/edits';
import { sessionLoadOf } from '../../../domain/training/metrics';
import {
	otherDetailsSchema,
	PRESCRIPTION_LIMITS,
	runSegmentSchema,
	setPrescriptionSchema
} from '../../../domain/training/schemas';
import type { OtherDetails, RunSegment, SetPrescription } from '../../../domain/training/types';
import {
	SET_ROLE_LABEL,
	type DecisionKind,
	type Decider,
	type PreferenceSource,
	type SubstitutionReason
} from '../../../domain/training/vocabulary';
import {
	createProgramsRepository,
	type ExerciseChange,
	type LineChildRows,
	type SegmentChange,
	type SessionChange,
	type SetChange
} from '../../db/repositories/programs';
import type { Executor } from '../../db/types';
import { measure } from '../../observability/timing';
import { getExercisesByIds, type ExerciseDef } from '../exercises/index';
import { isUuid } from '../ids';
import { recordExercisePreference } from '../training/preferences';
import {
	parseWith,
	ProgramConflictError,
	resolveDeps,
	TrainingInputError,
	TrainingNotFoundError,
	type TrainingDeps
} from '../training/shared';
import { programmingInputFor, rankAlternatives } from './alternatives';
import { toStoredSessions, type StoredExercise, type StoredSession } from './mapping';
import {
	reviseProgram,
	type CopyChanges,
	type RevisedVersion,
	type RevisionDecision
} from './revise';
import { MAX_VERSION } from './store';

/** sessionPlanSchema's bound on one day's sessions: a move never makes a fifth. */
const SESSIONS_A_DAY = 4;

/** decisionPlanSchema's bound on a decision's 'why'. */
const WHY_MAX = 1000;

/** Who an edit's 'why' says decided. */
const WHO: Readonly<Record<Decider, string>> = {
	owner: 'You',
	coach: 'The coach',
	rules: 'The programming rules'
};

/** What a day of the Move sheet says when nothing will happen on it. */
const REST_DAY = 'Rest day';

/** Where an edit is made: on the version the owner saw, on the owner's today. */
export interface EditAt {
	/** It must still be the current version, or the edit is a ProgramConflictError. */
	version: number;
	/** The owner's local date (ownerToday): nothing before it can be edited. */
	today: IsoDate;
}

/** A day a session can move to, with what is planned there in one line. */
export interface MoveTarget {
	date: IsoDate;
	/** 'Upper A · Easy run', or 'Rest day'. */
	planned: string;
}

/** An interference rule that a move newly breaks. */
export interface MoveWarning {
	rule: InterferenceRule;
	severity: Severity;
	/** The dates it spans, earliest first. */
	days: IsoDate[];
	/** One sentence naming its days and sessions, as the decision records it. */
	message: string;
}

export interface MovedSession extends RevisedVersion {
	warnings: MoveWarning[];
}

/**
 * An edit worked out on the version it was made on, before anything is written: the weeks it
 * copies, how the copies differ, its decision, and a write of its own outside the program (a
 * never-again swap's dislike), which runs in the revising transaction.
 */
export interface PlannedEdit {
	weekLineages: string[];
	changes: CopyChanges;
	decision: RevisionDecision;
	write?: (tx: Executor) => Promise<void>;
	/**
	 * An adjustment's session and its estimate: from every change `changes` makes to the session's
	 * prescription, each composed row checked whole with M3's schema (a TrainingInputError), the
	 * session's estimate and load worked out again. Several adjustments of one session compose.
	 */
	settle?: { session: string; estimate: (changes: CopyChanges) => SessionChange };
}

/** `changes` with `edit`'s session estimate worked out on them, when it is an adjustment. */
export function settled(changes: CopyChanges, edit: PlannedEdit): CopyChanges {
	if (!edit.settle) return changes;
	const { session, estimate } = edit.settle;
	const sessions = changes.sessions ?? {};
	return {
		...changes,
		sessions: { ...sessions, [session]: { ...sessions[session], ...estimate(changes) } }
	};
}

/** An edit's body: checks `input` on version `at.version` and plans it, writing nothing. */
export type EditApplier = (
	ownerId: string,
	input: unknown,
	at: EditAt,
	deps?: TrainingDeps
) => Promise<PlannedEdit>;

/** Write one planned edit as the next version. */
function revise(
	ownerId: string,
	edit: PlannedEdit,
	at: EditAt,
	deps: TrainingDeps
): Promise<RevisedVersion> {
	return reviseProgram(
		ownerId,
		{
			baseVersionNumber: at.version,
			weekLineages: edit.weekLineages,
			apply: async (_copies, tx) => {
				await edit.write?.(tx);
				return settled(edit.changes, edit);
			},
			decision: edit.decision
		},
		deps
	);
}

type ExerciseRow = LineChildRows['exercises'][number];

/** A session to edit, in its week of the version read. */
interface Target {
	versionId: string;
	versionNumber: number;
	week: { id: string; lineageId: string; startsOn: IsoDate; endsOn: IsoDate };
	/** Its week's sessions, by day and order in the day; `session` is one of them. */
	sessions: StoredSession[];
	session: StoredSession;
	completed: boolean;
	/** The week's planned exercise rows by lineage, with their library ids and names. */
	exerciseRows: Map<string, ExerciseRow>;
}

function checkToday(today: unknown): IsoDate {
	if (typeof today === 'string' && parseIsoDate(today)) return today;
	throw new TrainingInputError({ today: 'Not a calendar date (YYYY-MM-DD)' });
}

/**
 * The session `lineage` in the active program's current version, or in version `version`: a
 * ProgramConflictError when that version is no longer current.
 */
async function locate(
	db: Executor,
	ownerId: string,
	lineage: string,
	version?: number
): Promise<Target> {
	if (!isUuid(lineage)) throw new TrainingNotFoundError('planned session');
	const known = (n: number) => Number.isInteger(n) && n >= 1 && n <= MAX_VERSION;
	if (version !== undefined && !known(version)) throw new TrainingNotFoundError('program version');
	return measure('db', async () => {
		const repo = createProgramsRepository(db);
		const found = await repo.currentProgram(ownerId, version);
		if (!found) {
			throw new TrainingNotFoundError(version === undefined ? 'program' : 'program version');
		}
		if (found.version.id !== found.program.currentVersionId) throw new ProgramConflictError();
		const hit = await repo.sessionByLineage(found.version.id, lineage);
		if (!hit) throw new TrainingNotFoundError('planned session');
		const rows = await repo.weekSessions([hit.week.id]);
		const sessions = [...toStoredSessions(rows).values()];
		const completed = await repo.completedLineages(ownerId, [lineage]);
		return {
			versionId: found.version.id,
			versionNumber: found.version.number,
			exerciseRows: new Map(rows.exercises.map((row) => [row.lineageId, row])),
			week: hit.week,
			sessions,
			session: sessions.find((s) => s.lineage === lineage)!,
			completed: completed.has(lineage)
		};
	});
}

/**
 * Decision (m3-plan open question on moves): a session moves only within its own Monday-to-
 * Sunday week, so a move copies that one week, and only to a day from today on. Reaching other
 * weeks would copy the destination week too and move the session's row into it.
 */
function reachableDates({ week }: Target, today: IsoDate): IsoDate[] {
	const dates: IsoDate[] = [];
	for (let date = week.startsOn; date <= week.endsOn; date = addDays(date, 1)) {
		if (date >= today) dates.push(date);
	}
	return dates;
}

/** Why the session cannot be edited at all, if it cannot. */
function sessionRefusal({ session, completed }: Target, today: IsoDate): string | null {
	if (completed) return 'This session is done';
	if (session.status === 'skipped') return 'This session is skipped';
	if (session.date < today) return 'This session has passed';
	return null;
}

/** Why the session cannot move to `toDate`, if it cannot. */
function destinationRefusal(target: Target, toDate: IsoDate, today: IsoDate): string | null {
	const { week, session, sessions } = target;
	if (toDate < week.startsOn || toDate > week.endsOn) return 'Pick a day in its own week';
	if (toDate < today) return 'That day has passed';
	if (toDate === session.date) return 'It is already on that day';
	if (sessions.filter((s) => s.date === toDate).length >= SESSIONS_A_DAY) {
		return 'That day already has four sessions';
	}
	return null;
}

/** A time of day's place in the day; none for no time or 'varies'. */
const timeRank = (time: TimeOfDay | null) =>
	time === null || time === 'varies' ? null : TIMES_OF_DAY.indexOf(time);

/** The sessions that will happen: what the interference rules read. */
const happening = (sessions: StoredSession[]) => sessions.filter((s) => s.status !== 'skipped');

/** A violation by its rule, days and sessions, to tell one the move made from one already there. */
const violationKey = (v: Violation<StoredSession>) =>
	[v.rule, ...v.days, ...v.sessions.map((s) => s.lineage)].join(' ');

/**
 * The move as copy changes and the warnings it brings. On its new day, the session goes before
 * the first session with a later time of day, or last, and that day is numbered again from 1.
 * Back on the day it was planned for, it is planned again; otherwise it keeps the day of its
 * first move as moved_from.
 */
function planMove(target: Target, move: MoveSessionInput, today: IsoDate) {
	const errors: Record<string, string> = {};
	const refused = sessionRefusal(target, today);
	if (refused) errors.sessionLineage = refused;
	const away = destinationRefusal(target, move.toDate, today);
	if (away) errors.toDate = away;
	if (Object.keys(errors).length > 0) throw new TrainingInputError(errors);

	const { session, sessions } = target;
	const timeOfDay = move.timeOfDay === undefined ? session.timeOfDay : move.timeOfDay;
	const rank = timeRank(timeOfDay);
	const day = sessions.filter((s) => s.date === move.toDate);
	const later = day.findIndex((s) => rank !== null && (timeRank(s.timeOfDay) ?? -1) > rank);
	const place = later === -1 ? day.length : later;
	const firstDay = session.movedFrom ?? session.date;
	const back = move.toDate === firstDay;

	const changes: Record<string, SessionChange> = {};
	const order = new Map<string, number>();
	[...day.slice(0, place), session, ...day.slice(place)].forEach((s, n) => {
		order.set(s.lineage, n + 1);
		if (s !== session && s.orderInDay !== n + 1) changes[s.lineage] = { orderInDay: n + 1 };
	});
	changes[session.lineage] = {
		scheduledOn: move.toDate,
		timeOfDay,
		orderInDay: order.get(session.lineage)!,
		status: back ? 'planned' : 'moved',
		movedFrom: back ? null : firstDay
	};
	const after = sessions.map((s): StoredSession => {
		const orderInDay = order.get(s.lineage) ?? s.orderInDay;
		return s === session
			? { ...s, date: move.toDate, timeOfDay, orderInDay }
			: { ...s, orderInDay };
	});

	const options = { openDates: reachableDates(target, today) };
	const before = new Set(checkWeek(happening(sessions), options).map(violationKey));
	const warnings = checkWeek(happening(after), options)
		.filter((v) => !before.has(violationKey(v)))
		.map(({ rule, severity, days, message }): MoveWarning => ({ rule, severity, days, message }));
	return { changes, warnings };
}

const dayLabel = (date: IsoDate) => WEEKDAY_INFO[weekdayOf(date)].short;

/** The owner's reason as a sentence, or NO_REASON. */
function reasonText(reason: string | undefined): string {
	const text = reason?.trim();
	if (!text) return NO_REASON;
	return /[.!?…]$/.test(text) ? text : `${text}.`;
}

const more = (n: number) => ` And ${n} more ${n === 1 ? 'warning' : 'warnings'}.`;

/**
 * The warnings as the 'why' ends with them, each after a space: as many as fit in `room`
 * characters, then how many more there are.
 */
function warningsText(messages: readonly string[], room: number): string {
	let text = '';
	for (const [n, message] of messages.entries()) {
		const next = `${text} ${message}`;
		const left = messages.length - n - 1;
		if (next.length + (left > 0 ? more(left).length : 0) > room) return text + more(left + 1);
		text = next;
	}
	return text;
}

function moveDecision(
	session: StoredSession,
	toDate: IsoDate,
	reason: string | undefined,
	warnings: MoveWarning[],
	source: Decider
): RevisionDecision {
	const template = TEMPLATES.session_moved;
	const facts = {
		who: WHO[source],
		session: session.title,
		from: dayLabel(session.date),
		to: dayLabel(toDate),
		reason: reasonText(reason)
	};
	const head = render(template.why, { ...facts, warnings: '' }, 'session_moved');
	const messages = warnings.map((w) => w.message);
	return {
		kind: 'session_moved',
		summary: render(template.summary, facts, 'session_moved'),
		why: head + warningsText(messages, WHY_MAX - head.length),
		affected: [session.lineage],
		evidence: { from: session.date, to: toDate, warnings: warnings.length }
	};
}

/**
 * The days the session `lineage` of the current version can move to, from `today` on: none for a
 * session that has passed, is skipped or is done, or when no day of its week is left.
 */
export async function getMoveTargets(
	ownerId: string,
	lineage: string,
	today: IsoDate,
	deps: TrainingDeps = {}
): Promise<MoveTarget[]> {
	checkToday(today);
	const target = await locate(resolveDeps(deps).db, ownerId, lineage);
	if (sessionRefusal(target, today)) return [];
	return reachableDates(target, today)
		.filter((date) => destinationRefusal(target, date, today) === null)
		.map((date) => {
			const titles = happening(target.sessions)
				.filter((s) => s.date === date)
				.map((s) => s.title);
			return { date, planned: titles.join(' · ') || REST_DAY };
		});
}

/** The warnings `move` would record, before it is saved; it is refused as moveSession refuses it. */
export async function checkMove(
	ownerId: string,
	input: unknown,
	at: EditAt,
	deps: TrainingDeps = {}
): Promise<MoveWarning[]> {
	const move = parseWith(moveSessionSchema, input);
	const today = checkToday(at.today);
	const target = await locate(resolveDeps(deps).db, ownerId, move.sessionLineage, at.version);
	return planMove(target, move, today).warnings;
}

/** moveSession's applier: the move, its decision and the warnings it brings. */
export async function moveApplier(
	ownerId: string,
	input: unknown,
	at: EditAt,
	deps: TrainingDeps = {}
): Promise<PlannedEdit & { warnings: MoveWarning[] }> {
	const move = parseWith(moveSessionSchema, input);
	const today = checkToday(at.today);
	const { db, source } = resolveDeps(deps);
	const target = await locate(db, ownerId, move.sessionLineage, at.version);
	const { changes, warnings } = planMove(target, move, today);
	const blocking = warnings.find((w) => BLOCKS_EDIT[w.severity]);
	if (blocking) throw new TrainingInputError({ toDate: blocking.message });
	return {
		weekLineages: [target.week.lineageId],
		changes: { sessions: changes },
		decision: moveDecision(target.session, move.toDate, move.reason, warnings, source),
		warnings
	};
}

/**
 * Move a session to another day of its week as the next version, with its reason and the
 * interference rules it newly breaks; those warnings are returned too.
 */
export async function moveSession(
	ownerId: string,
	input: unknown,
	at: EditAt,
	deps: TrainingDeps = {}
): Promise<MovedSession> {
	const { warnings, ...edit } = await moveApplier(ownerId, input, at, deps);
	return { ...(await revise(ownerId, edit, at, deps)), warnings };
}

/** Skip a session as the next version, with its reason. */
export async function skipSession(
	ownerId: string,
	input: unknown,
	at: EditAt,
	deps: TrainingDeps = {}
): Promise<RevisedVersion> {
	return revise(ownerId, await skipApplier(ownerId, input, at, deps), at, deps);
}

/** skipSession's applier. */
export async function skipApplier(
	ownerId: string,
	input: unknown,
	at: EditAt,
	deps: TrainingDeps = {}
): Promise<PlannedEdit> {
	const skip = parseWith(skipSessionSchema, input);
	const today = checkToday(at.today);
	const { db, source } = resolveDeps(deps);
	const target = await locate(db, ownerId, skip.sessionLineage, at.version);
	const refused = sessionRefusal(target, today);
	if (refused) throw new TrainingInputError({ sessionLineage: refused });
	const { session } = target;
	const template = TEMPLATES.session_skipped;
	const facts = {
		who: WHO[source],
		session: session.title,
		day: dayLabel(session.date),
		reason: reasonText(skip.reason)
	};
	return {
		weekLineages: [target.week.lineageId],
		changes: { sessions: { [session.lineage]: { status: 'skipped' } } },
		decision: {
			kind: 'session_skipped',
			summary: render(template.summary, facts, 'session_skipped'),
			why: render(template.why, facts, 'session_skipped'),
			affected: [session.lineage],
			evidence: { date: session.date }
		}
	};
}

// ---- swap -----------------------------------------------------------------------------------

/**
 * Decision (m3-plan open question on 'Never prescribe this again'): the swap replaces the
 * exercise in every session of the current program from today. false swaps this session only,
 * and the dislike it saves then applies from the next program generated.
 */
export const NEVER_AGAIN_REPLACES_UPCOMING = true;

/** What an adjustment that changes nothing is refused with, at `sessionLineage`. */
export const NOTHING_CHANGED = 'Nothing has changed';

/** The 'why' of an edit: its template filled, the owner's reason or NO_REASON last. */
function edited(kind: DecisionKind, facts: Record<string, string>, affected: string[]) {
	const template = TEMPLATES[kind];
	return {
		kind,
		summary: render(template.summary, facts, kind),
		why: render(template.why, facts, kind),
		affected
	};
}

/** The planned exercise `lineage` of the target session, and its row. */
function plannedIn({ session, exerciseRows }: Target, lineage: string) {
	const planned =
		session.kind === 'strength' ? session.exercises.find((e) => e.lineage === lineage) : undefined;
	const row = exerciseRows.get(lineage);
	if (!planned || !row) throw new TrainingNotFoundError('planned exercise');
	return { planned, row };
}

/** A planned exercise and its row, in a session of the version edited. */
interface Occurrence {
	weekLineage: string;
	session: StoredSession;
	planned: StoredExercise;
	row: ExerciseRow;
}

/**
 * The planned exercise as `to`, with what it replaced and why. Back to the exercise first
 * prescribed, it is no longer a substitute. Its loads move only within the same baseline lift:
 * otherwise every set is RPE-based at its own target RPE (the session's, within set bounds, when
 * it has none), as M4's prefill expects of a swap, and the old lift's instructions go with it.
 */
function swapped({ session, planned, row }: Occurrence, to: ExerciseDef, why: SubstitutionReason) {
	const first = row.substitutedFromExerciseId ?? row.exerciseId;
	const back = first === to.id;
	const keepsLoad = planned.baselineLift !== null && planned.baselineLift === to.baselineLift;
	const exercise: ExerciseChange = {
		exerciseId: to.id,
		substitutedFromExerciseId: back ? null : first,
		substitutionReason: back ? null : why,
		...(keepsLoad ? {} : { baselineLift: to.baselineLift, instructions: null })
	};
	const [low, high] = PRESCRIPTION_LIMITS.rpe;
	const sessionRpe = Math.min(high, Math.max(low, Math.round(session.targetRpe * 2) / 2));
	const sets: Record<number, SetChange> = {};
	planned.sets.forEach((set, k) => {
		if (keepsLoad || set.loadKind === 'rpe_based') return;
		sets[k + 1] = {
			loadKind: 'rpe_based',
			loadValue: null,
			loadUnit: null,
			loadBasis: null,
			reference1rm: null,
			reference1rmUnit: null,
			targetRpe: set.targetRpe ?? sessionRpe
		};
	});
	return { exercise, sets };
}

/** Every planned exercise of the version that is `exerciseId`, from `today` on, not yet done. */
async function occurrencesFrom(
	db: Executor,
	ownerId: string,
	versionId: string,
	exerciseId: string,
	today: IsoDate
): Promise<Occurrence[]> {
	return measure('db', async () => {
		const repo = createProgramsRepository(db);
		const weeks = (await repo.versionWeeks(versionId)).filter((w) => w.endsOn >= today);
		if (!weeks.length) return [];
		const rows = await repo.weekSessions(weeks.map((w) => w.id));
		const sessions = toStoredSessions(rows);
		const weekOf = new Map(weeks.map((w) => [w.id, w.lineageId]));
		const sessionRows = new Map(rows.sessions.map((s) => [s.id, s]));
		const found = rows.exercises.flatMap((row): Occurrence[] => {
			const at = sessionRows.get(row.sessionId)!;
			const session = sessions.get(row.sessionId)!;
			if (row.exerciseId !== exerciseId || at.scheduledOn < today) return [];
			const planned = session.kind === 'strength' && session.exercises;
			const exercise = planned && planned.find((e) => e.lineage === row.lineageId);
			if (!exercise) return [];
			return [{ weekLineage: weekOf.get(at.weekId)!, session, planned: exercise, row }];
		});
		const done = await repo.completedLineages(
			ownerId,
			found.map((o) => o.session.lineage)
		);
		return found.filter((o) => !done.has(o.session.lineage));
	});
}

/** What a caller other than Train's swap sheet gives a swap (M4's amendment A6). */
export interface SwapOptions {
	/**
	 * Where the dislike a 'never_again' swap saves was said: 'swap' (Train) by default, 'coach'
	 * for an accepted proposal (./batch.ts).
	 */
	preferenceSource?: Extract<PreferenceSource, 'swap' | 'workout' | 'coach'>;
	/**
	 * The session may have passed or be done (a workout's dislike synced late): a never-again swap
	 * then changes only the occurrences from today, never that session.
	 */
	anchorMayHavePassed?: boolean;
}

/** A planned exercise as a workout performs it: its session, its lineage and its exercise. */
export interface PlannedSlot {
	sessionLineage: string;
	plannedExerciseLineage: string;
	exerciseId: string;
}

/**
 * Base 'current' for a swap made in the caller's transaction (M4's amendment A6; deps.db must be
 * that transaction): lock the owner's active program until the transaction ends, then answer the
 * number of its current version when that version still performs the slot's exercise. A swap on
 * that number cannot meet a conflict, whatever version the caller saw. Null when the slot is gone:
 * no active program, the session or the planned exercise no longer in it, the session skipped or
 * the exercise swapped. A session that has passed or is done (a dislike synced the next day)
 * still answers while a session from `today` performs the exercise, for a swap of those only
 * (SwapOptions.anchorMayHavePassed).
 */
export async function lockCurrentSlot(
	ownerId: string,
	slot: PlannedSlot,
	today: IsoDate,
	deps: TrainingDeps = {}
): Promise<number | null> {
	const { db } = resolveDeps(deps);
	if (!(await createProgramsRepository(db).lockProgram(ownerId))) return null;
	const target = await locate(db, ownerId, slot.sessionLineage).catch((err: unknown) => {
		if (err instanceof TrainingNotFoundError) return null;
		throw err;
	});
	if (!target || target.session.status === 'skipped') return null;
	const planned =
		target.session.kind === 'strength' &&
		target.session.exercises.some((e) => e.lineage === slot.plannedExerciseLineage);
	const row = target.exerciseRows.get(slot.plannedExerciseLineage);
	if (!planned || row?.exerciseId !== slot.exerciseId) return null;
	const day = checkToday(today);
	if (!sessionRefusal(target, day)) return target.versionNumber;
	if (!NEVER_AGAIN_REPLACES_UPCOMING) return null;
	const upcoming = await occurrencesFrom(db, ownerId, target.versionId, slot.exerciseId, day);
	return upcoming.length ? target.versionNumber : null;
}

/**
 * Swap a planned exercise for one of its alternatives as the next version, with its reason.
 * 'once' changes that session only and records no preference. 'never_again' saves a dislike
 * (source 'swap', or how.preferenceSource) in the same transaction, under the preferences
 * lock, and swaps the exercise in every session from today; each week it touches is copied. A
 * target that is not one of the exercise's alternatives is a field error at `toExerciseId`.
 */
export async function swapExercise(
	ownerId: string,
	input: unknown,
	at: EditAt,
	deps: TrainingDeps = {},
	how: SwapOptions = {}
): Promise<RevisedVersion> {
	return revise(ownerId, await swapApplier(ownerId, input, at, deps, how), at, deps);
}

/** swapExercise's applier: a never-again swap's dislike is its write. */
export async function swapApplier(
	ownerId: string,
	input: unknown,
	at: EditAt,
	deps: TrainingDeps = {},
	how: SwapOptions = {}
): Promise<PlannedEdit> {
	const swap = parseWith(swapSchema, input);
	const today = checkToday(at.today);
	const { db, source } = resolveDeps(deps);
	const target = await locate(db, ownerId, swap.sessionLineage, at.version);
	const never = swap.scope === 'never_again';
	const refused = sessionRefusal(target, today);
	const late =
		how.anchorMayHavePassed &&
		never &&
		NEVER_AGAIN_REPLACES_UPCOMING &&
		target.session.status !== 'skipped';
	if (refused && !late) throw new TrainingInputError({ sessionLineage: refused });
	const { planned, row } = plannedIn(target, swap.plannedExerciseLineage);
	const key = toExerciseKey(planned.exercise);
	const options = await rankAlternatives(ownerId, key, { db });
	const to = (await getExercisesByIds(ownerId, [swap.toExerciseId], { db })).get(swap.toExerciseId);
	if (!to || !options.alternatives.some((a) => a.id === to.id)) {
		// One it would offer but may not have says why; any other is not an alternative at all.
		const toKey = to && (to.key ?? `custom:${to.id}`);
		const excluded = options.excluded.find((e) => e.key === toKey);
		const why = excluded?.reasons.map((r) => r.text).join('. ');
		throw new TrainingInputError({
			toExerciseId: why ?? `Not an alternative to ${row.exerciseName.toLowerCase()}`
		});
	}
	const here = { weekLineage: target.week.lineageId, session: target.session, planned, row };
	const occurrences =
		never && NEVER_AGAIN_REPLACES_UPCOMING
			? await occurrencesFrom(db, ownerId, target.versionId, row.exerciseId, today)
			: [here];
	if (!occurrences.length) throw new TrainingInputError({ sessionLineage: refused! });
	const changes: Required<Pick<CopyChanges, 'exercises' | 'sets'>> = { exercises: {}, sets: {} };
	for (const occurrence of occurrences) {
		const { exercise, sets } = swapped(occurrence, to, never ? 'dislike' : 'situational');
		changes.exercises[occurrence.planned.lineage] = exercise;
		if (Object.keys(sets).length) changes.sets[occurrence.planned.lineage] = sets;
	}
	const sessions = [...new Set(occurrences.map((o) => o.session.lineage))];
	const facts = { who: WHO[source], from: row.exerciseName, to: to.name };
	const reason = reasonText(swap.reason);
	const decision = never
		? edited(
				'preference_recorded',
				{
					...facts,
					exercise: row.exerciseName,
					sessions: `${sessions.length} ${sessions.length === 1 ? 'session' : 'sessions'}`,
					reason
				},
				sessions.slice(0, 50)
			)
		: edited(
				'exercise_swapped',
				{
					...facts,
					scope: `in ${target.session.title} on ${dayLabel(target.session.date)}, this session only`,
					reason
				},
				[target.session.lineage, planned.lineage]
			);
	const dislike = async (tx: Executor) => {
		const source = how.preferenceSource ?? 'swap';
		const record = { sentiment: 'dislike' as const, source, exerciseId: row.exerciseId };
		await recordExercisePreference(
			ownerId,
			{ ...record, reason: swap.reason },
			{ ...deps, db: tx }
		);
	};
	return {
		weekLineages: occurrences.map((o) => o.weekLineage),
		changes,
		decision: { ...decision, evidence: { to: to.id, scope: swap.scope } },
		...(never ? { write: dislike } : {})
	};
}

// ---- adjust ---------------------------------------------------------------------------------

/** The fields an adjustment gives, without the ones left out. */
function given<T extends object>(values: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(values).filter(([, value]) => value !== undefined)
	) as Partial<T>;
}

/** The fields of `after` that differ from `before`. */
function differences<T extends object>(before: T, after: T): Partial<T> {
	const keys = Object.keys(after) as (keyof T)[];
	return Object.fromEntries(
		keys.filter((k) => after[k] !== before[k]).map((k) => [k, after[k]])
	) as Partial<T>;
}

const clampMinutes = (minutes: number) => Math.min(600, Math.max(5, minutes));

/** A session's estimate and load for `minutes` at its target RPE, through M1's sessionLoad. */
const timed = (estMinutes: number, targetRpe: number): SessionChange => ({
	estMinutes: clampMinutes(estMinutes),
	estLoad: sessionLoadOf({ estMinutes: clampMinutes(estMinutes), targetRpe }),
	targetRpe
});

/** Refuse an edit to a session that has passed, is skipped or is done. */
function editable(target: Target, today: IsoDate) {
	const refused = sessionRefusal(target, today);
	if (refused) throw new TrainingInputError({ sessionLineage: refused });
}

/** An adjustment as a planned edit, with a prescription_adjusted decision. */
function adjusted(
	target: Target,
	deps: TrainingDeps,
	adjustment: { what: string; before: string; after: string; reason?: string },
	changes: CopyChanges,
	affected: string[],
	estimate: (changes: CopyChanges) => SessionChange
): PlannedEdit {
	const facts = {
		who: WHO[resolveDeps(deps).source],
		what: adjustment.what,
		before: adjustment.before,
		after: adjustment.after,
		reason: reasonText(adjustment.reason)
	};
	return {
		weekLineages: [target.week.lineageId],
		changes,
		decision: edited('prescription_adjusted', facts, affected),
		settle: { session: target.session.lineage, estimate }
	};
}

/** A set prescription as one line: '3 × 5 @ RPE 8, 100 kg, rest 2:00'. */
function setWords(set: SetPrescription): string {
	const unit = set.loadUnit ?? set.reference1rmUnit ?? 'kg';
	const words = describePrescription(set, { unit });
	return [words.headline, words.load, words.rest?.toLowerCase()].filter(Boolean).join(', ');
}

/**
 * Adjust a strength set prescription (sets, reps, RPE, load value, rest) as the next version.
 * The set it gives is checked whole with setPrescriptionSchema, and the session's estimate and
 * load are worked out again.
 */
export async function adjustPrescription(
	ownerId: string,
	input: unknown,
	at: EditAt,
	deps: TrainingDeps = {}
): Promise<RevisedVersion> {
	return revise(ownerId, await setApplier(ownerId, input, at, deps), at, deps);
}

/** adjustPrescription's applier. */
export async function setApplier(
	ownerId: string,
	input: unknown,
	at: EditAt,
	deps: TrainingDeps = {}
): Promise<PlannedEdit> {
	const { sessionLineage, plannedExerciseLineage, position, reason, ...values } = parseWith(
		adjustSetSchema,
		input
	);
	const today = checkToday(at.today);
	const { db } = resolveDeps(deps);
	const target = await locate(db, ownerId, sessionLineage, at.version);
	editable(target, today);
	const { planned, row } = plannedIn(target, plannedExerciseLineage);
	const before = planned.sets[position - 1];
	if (!before) throw new TrainingNotFoundError('set prescription');
	const after = parseWith(setPrescriptionSchema, { ...before, ...given(values) });
	const change = differences(before, after);
	if (!Object.keys(change).length)
		throw new TrainingInputError({ sessionLineage: NOTHING_CHANGED });

	const session = target.session as Extract<StoredSession, { kind: 'strength' }>;
	const programming = await programmingInputFor(ownerId, { db });
	const estimate = ({ sets }: CopyChanges) => {
		const exercises = session.exercises.map((e) => {
			const change = sets?.[e.lineage];
			if (!change) return e;
			const composed = e.sets.map((s, k) =>
				parseWith(setPrescriptionSchema, { ...s, ...change[k + 1] })
			);
			return { ...e, sets: composed };
		});
		return timed(estimateMinutes({ exercises }, programming), session.targetRpe);
	};
	return adjusted(
		target,
		deps,
		{
			what: `${row.exerciseName}, ${SET_ROLE_LABEL[before.role].toLowerCase()}`,
			before: setWords(before),
			after: setWords(after),
			reason
		},
		{ sets: { [planned.lineage]: { [position]: change } } },
		[session.lineage, planned.lineage],
		estimate
	);
}

/**
 * About how long a run takes, in whole minutes: each segment's time, or its distance at the
 * middle of its pace range (ASSUMED_EASY_PACE without one), every repeat counted.
 */
export function runMinutes(segments: readonly RunSegment[]): number {
	let seconds = 0;
	for (const s of segments) {
		const pace =
			s.paceMinSecondsPerKm !== null && s.paceMaxSecondsPerKm !== null
				? (s.paceMinSecondsPerKm + s.paceMaxSecondsPerKm) / 2
				: ASSUMED_EASY_PACE;
		const one = s.durationSeconds ?? ((s.distanceMetres ?? 0) / 1000) * pace;
		seconds += one * (s.repeats ?? 1);
	}
	return Math.ceil(seconds / 60);
}

/** A run segment as one line: '5 × Interval 400 m, 4:00–4:10 /km'. */
function segmentWords(s: RunSegment): string {
	const words = describeSegment(s, { distanceUnit: 'km' });
	const line = [words.headline, words.pace, words.target].filter(Boolean).join(', ');
	return s.repeats === null ? line : `${s.repeats} × ${line}`;
}

/**
 * Adjust a run segment (distance, duration, pace range, RPE, heart-rate zone, repeats) as the
 * next version. Repeats belong to its repeat group, so every segment of the group takes them. The
 * segment it gives is checked whole with runSegmentSchema, and the run's estimate and load are
 * worked out again.
 */
export async function adjustRunSegment(
	ownerId: string,
	input: unknown,
	at: EditAt,
	deps: TrainingDeps = {}
): Promise<RevisedVersion> {
	return revise(ownerId, await runSegmentApplier(ownerId, input, at, deps), at, deps);
}

/** adjustRunSegment's applier. */
export async function runSegmentApplier(
	ownerId: string,
	input: unknown,
	at: EditAt,
	deps: TrainingDeps = {}
): Promise<PlannedEdit> {
	const { sessionLineage, position, reason, ...values } = parseWith(adjustRunSegmentSchema, input);
	const today = checkToday(at.today);
	const { db } = resolveDeps(deps);
	const target = await locate(db, ownerId, sessionLineage, at.version);
	editable(target, today);
	const { session } = target;
	const before = session.kind === 'run' ? session.segments[position - 1] : undefined;
	if (session.kind !== 'run' || !before) throw new TrainingNotFoundError('run segment');
	const after = parseWith(runSegmentSchema, { ...before, ...given(values) });
	const group = before.repeatGroup;
	const segments = session.segments.map((s, k) =>
		k === position - 1
			? after
			: group !== null && s.repeatGroup === group
				? { ...s, repeats: after.repeats }
				: s
	);
	const changed: Record<number, SegmentChange> = {};
	segments.forEach((s, k) => {
		const change = differences(session.segments[k]!, s);
		if (Object.keys(change).length) changed[k + 1] = change;
	});
	if (!Object.keys(changed).length)
		throw new TrainingInputError({ sessionLineage: NOTHING_CHANGED });
	const estimate = (changes: CopyChanges) => {
		const change = changes.segments?.[session.lineage] ?? {};
		const composed = session.segments.map((s, k) =>
			parseWith(runSegmentSchema, { ...s, ...change[k + 1] })
		);
		return timed(runMinutes(composed), session.targetRpe);
	};
	return adjusted(
		target,
		deps,
		{
			what: `${session.title}, segment ${position}`,
			before: segmentWords(before),
			after: segmentWords(after),
			reason
		},
		{ segments: { [session.lineage]: changed } },
		[session.lineage],
		estimate
	);
}

const detailWords = (d: OtherDetails) =>
	d.targetRpe === null
		? `${d.durationMinutes} min`
		: `${d.durationMinutes} min @ RPE ${d.targetRpe}`;

/**
 * Adjust another session's length and RPE as the next version. The details it gives are checked
 * whole with otherDetailsSchema; the session's estimate is its length, its RPE the details' RPE,
 * and its load is worked out again through M1's sessionLoad.
 */
export async function adjustSessionDetails(
	ownerId: string,
	input: unknown,
	at: EditAt,
	deps: TrainingDeps = {}
): Promise<RevisedVersion> {
	return revise(ownerId, await detailsApplier(ownerId, input, at, deps), at, deps);
}

/** adjustSessionDetails's applier. */
export async function detailsApplier(
	ownerId: string,
	input: unknown,
	at: EditAt,
	deps: TrainingDeps = {}
): Promise<PlannedEdit> {
	const { sessionLineage, reason, ...values } = parseWith(adjustDetailsSchema, input);
	const today = checkToday(at.today);
	const { db } = resolveDeps(deps);
	const target = await locate(db, ownerId, sessionLineage, at.version);
	editable(target, today);
	const { session } = target;
	if (session.kind !== 'other') throw new TrainingNotFoundError('session details');
	const after = parseWith(otherDetailsSchema, { ...session.details, ...given(values) });
	const change = differences(session.details, after);
	if (!Object.keys(change).length)
		throw new TrainingInputError({ sessionLineage: NOTHING_CHANGED });
	return adjusted(
		target,
		deps,
		{
			what: session.title,
			before: detailWords(session.details),
			after: detailWords(after),
			reason
		},
		{ details: { [session.lineage]: change } },
		[session.lineage],
		({ details }) => {
			const composed = { ...session.details, ...details?.[session.lineage] };
			const d = parseWith(otherDetailsSchema, composed);
			return timed(d.durationMinutes, d.targetRpe ?? session.targetRpe);
		}
	);
}
