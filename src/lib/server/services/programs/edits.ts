/**
 * The owner's first program edits (PRD §5, ADR 0010): move a planned session to another day of
 * its week, or skip it. Each is a revision (reviseProgram): a new version that copies the
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
 *
 * The checks read the version the edit was made on. Its rows never change, so what they find is
 * what reviseProgram copies; it then writes only if that version is still the current one.
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
import {
	moveSessionSchema,
	skipSessionSchema,
	type MoveSessionInput
} from '../../../domain/training/edits';
import type { Decider } from '../../../domain/training/vocabulary';
import { createProgramsRepository, type SessionChange } from '../../db/repositories/programs';
import type { Executor } from '../../db/types';
import { measure } from '../../observability/timing';
import { isUuid } from '../ids';
import {
	parseWith,
	ProgramConflictError,
	resolveDeps,
	TrainingInputError,
	TrainingNotFoundError,
	type TrainingDeps
} from '../training/shared';
import { toStoredSessions, type StoredSession } from './mapping';
import { reviseProgram, type RevisedVersion, type RevisionDecision } from './revise';
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

/** A session to edit, in its week of the version read. */
interface Target {
	week: { id: string; lineageId: string; startsOn: IsoDate; endsOn: IsoDate };
	/** Its week's sessions, by day and order in the day; `session` is one of them. */
	sessions: StoredSession[];
	session: StoredSession;
	completed: boolean;
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
		const sessions = [...toStoredSessions(await repo.weekSessions([hit.week.id])).values()];
		const completed = await repo.completedLineages(ownerId, [lineage]);
		return {
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
	const move = parseWith(moveSessionSchema, input);
	const today = checkToday(at.today);
	const { db, source } = resolveDeps(deps);
	const target = await locate(db, ownerId, move.sessionLineage, at.version);
	const { changes, warnings } = planMove(target, move, today);
	const blocking = warnings.find((w) => BLOCKS_EDIT[w.severity]);
	if (blocking) throw new TrainingInputError({ toDate: blocking.message });
	const revised = await reviseProgram(
		ownerId,
		{
			baseVersionNumber: at.version,
			weekLineages: [target.week.lineageId],
			apply: async () => ({ sessions: changes }),
			decision: moveDecision(target.session, move.toDate, move.reason, warnings, source)
		},
		deps
	);
	return { ...revised, warnings };
}

/** Skip a session as the next version, with its reason. */
export async function skipSession(
	ownerId: string,
	input: unknown,
	at: EditAt,
	deps: TrainingDeps = {}
): Promise<RevisedVersion> {
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
	return reviseProgram(
		ownerId,
		{
			baseVersionNumber: at.version,
			weekLineages: [target.week.lineageId],
			apply: async () => ({ sessions: { [session.lineage]: { status: 'skipped' } } }),
			decision: {
				kind: 'session_skipped',
				summary: render(template.summary, facts, 'session_skipped'),
				why: render(template.why, facts, 'session_skipped'),
				affected: [session.lineage],
				evidence: { date: session.date }
			}
		},
		deps
	);
}
