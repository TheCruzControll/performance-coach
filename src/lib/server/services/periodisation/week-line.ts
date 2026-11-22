/**
 * The week-kind line (m7/38 week-kind-indicators): a lighter or special week, named with one line
 * of why, for Train's header and Today's plan, and the word each week pill carries. Imported by
 * path: services/index.ts does not re-export it, and the folder has no index file.
 *
 * - Deload, taper, event, recovery, cutback and maintenance weeks (WEEK_KIND_WHY's kinds) have a
 *   line; every other week has none.
 * - Its why is the summary of the week's own decision, in WHY_SOURCES order: M7's (or M6's
 *   deload_scheduled, which M7 reuses), then M3's event_taper or block_structure, then
 *   WEEK_KIND_WHY's default, so an M3-built program's light weeks always say why.
 * - One decisions read (decisionsForLineages) over the week's lineage, its block's and the
 *   block's other weeks': a taper decision that names the taper week also explains the event
 *   week after it. A decision naming the week itself wins over one naming its block; between two
 *   as close, the one whose event is the nearest on or after the week.
 * - 'Marathon in 18 days': the nearest open goal's event within COUNTDOWN_DAYS joins the line.
 * - Owner-scoped: another owner's program, or a version it does not have, has no line or marks.
 * - It throws when a read fails: the screens record the failure and leave the line out.
 */
import { addDays, daysBetween, type IsoDate } from '../../../domain/calendar';
import { WEEK_KIND_WHY } from '../../../domain/programming/periodisation/kinds';
import { OPEN_GOAL_STATUSES, type GoalStatus } from '../../../domain/profile/catalog';
import type { DecisionKind, WeekKind } from '../../../domain/training/vocabulary';
import { createPeriodisationRepository } from '../../db/repositories/periodisation';
import { createProgramsRepository } from '../../db/repositories/programs';
import { measure } from '../../observability/timing';
import { resolveDeps, type TrainingDeps } from '../training/shared';

export type LineKind = keyof typeof WEEK_KIND_WHY;

const isLineKind = (kind: WeekKind): kind is LineKind => Object.hasOwn(WEEK_KIND_WHY, kind);

/** Decision (m7/38): how the header names each kind. */
export const WEEK_LINE_LABEL: Record<LineKind, string> = {
	deload: 'Deload week',
	taper: 'Taper',
	event: 'Event week',
	recovery: 'Recovery week',
	cutback: 'Cutback week',
	maintenance: 'Maintenance week'
};

/**
 * Decision (m7/38): the word a week pill carries. A maintenance week has the line but no word:
 * a maintenance block would mark every pill, which says nothing.
 */
export const WEEK_MARK: Partial<Record<LineKind, string>> = {
	deload: 'Deload',
	taper: 'Taper',
	event: 'Event',
	recovery: 'Recovery',
	cutback: 'Cutback'
};

/**
 * Where each kind's why comes from, in order: the week's own M7 decision, then M3's. A cutback
 * has neither (no decision is about one week's running volume), so it gives WEEK_KIND_WHY's.
 */
export const WHY_SOURCES: Record<LineKind, readonly (readonly DecisionKind[])[]> = {
	deload: [['deload_triggered', 'deload_scheduled'], ['block_structure']],
	taper: [['taper_planned'], ['event_taper']],
	event: [['taper_planned'], ['event_taper']],
	recovery: [['block_type_chosen']],
	cutback: [],
	maintenance: [['block_type_chosen']]
};

/** Decisions about an event's run-up: one naming any week of the block explains the others. */
const RUN_UP: readonly DecisionKind[] = ['taper_planned', 'event_taper'];

/**
 * Decision (m7/38, the 8 weeks in m7-plan): an event this many days ahead or fewer joins the
 * line as a countdown.
 */
export const COUNTDOWN_DAYS = 56;

/** The most decisions read for one week: a block's run-up holds a few of each kind at most. */
const DECISIONS_LIMIT = 20;

export interface WeekLine {
	/** 'Deload week'. */
	label: string;
	/** The week's decision's summary, or the kind's default reason. */
	why: string;
	/** 'Marathon in 18 days', with an event within COUNTDOWN_DAYS. */
	countdown?: string;
}

export interface WeekLineView {
	/** The week's line; null for a week of another kind. */
	line: WeekLine | null;
	/** The planned weeks' pill words, by the week's number among them (1 is week 1). */
	marks: Record<number, string>;
}

/** A goal, as far as the countdown reads it. */
export type CountdownGoal = { title: string; eventDate: IsoDate | null; status: GoalStatus };

export interface WeekLineAt {
	programId: string;
	/** The version shown, by number. */
	version: number;
	/** The Monday of the week shown. */
	weekStartsOn: IsoDate;
	/** The owner's today, which the countdown counts from. */
	today: IsoDate;
	/** The owner's goals: the countdown's events. */
	goals: readonly CountdownGoal[];
	/** False for only the pills' words: no line, and no decisions read. */
	withLine?: boolean;
}

/** 'Marathon in 18 days', 'Marathon tomorrow', 'Marathon today', or nothing. */
export function countdownOf(goals: readonly CountdownGoal[], today: IsoDate): string | undefined {
	const last = addDays(today, COUNTDOWN_DAYS);
	const next = goals
		.filter(
			(g): g is CountdownGoal & { eventDate: IsoDate } =>
				g.eventDate !== null &&
				OPEN_GOAL_STATUSES.includes(g.status) &&
				today <= g.eventDate &&
				g.eventDate <= last
		)
		.toSorted((a, b) => a.eventDate.localeCompare(b.eventDate))[0];
	if (!next) return undefined;
	const days = daysBetween(today, next.eventDate);
	return `${next.title} ${days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`}`;
}

/** The line of the week starting `weekStartsOn`, and every planned week's pill word. */
export function getWeekLine(
	ownerId: string,
	at: WeekLineAt,
	deps: TrainingDeps = {}
): Promise<WeekLineView> {
	return measure('periodisation', () => readWeekLine(ownerId, at, deps));
}

async function readWeekLine(
	ownerId: string,
	{ programId, version, weekStartsOn, today, goals, withLine = true }: WeekLineAt,
	deps: TrainingDeps
): Promise<WeekLineView> {
	const { db } = resolveDeps(deps);
	const programs = createProgramsRepository(db);
	const found = await programs.findVersion(ownerId, programId, version);
	if (!found) return { line: null, marks: {} };
	const { blocks, weeks } = await programs.versionOutline(found.version.id);
	const planned = new Set(blocks.filter((b) => !b.outline).map((b) => b.id));
	const marks: Record<number, string> = {};
	weeks
		.filter((w) => planned.has(w.blockId))
		.forEach((w, i) => {
			const mark = isLineKind(w.kind) ? WEEK_MARK[w.kind] : undefined;
			if (mark) marks[i + 1] = mark;
		});

	const week = weeks.find((w) => w.startsOn === weekStartsOn);
	if (!withLine || !week || !isLineKind(week.kind)) return { line: null, marks };
	const block = blocks.find((b) => b.id === week.blockId)!;
	const siblings = weeks.filter((w) => w.blockId === block.id && w.id !== week.id);
	const tiers = WHY_SOURCES[week.kind];
	const rows = tiers.length
		? await createPeriodisationRepository(db).decisionsForLineages(
				ownerId,
				programId,
				[week.lineageId, block.lineageId, ...siblings.map((w) => w.lineageId)],
				{ kinds: tiers.flat(), limit: DECISIONS_LIMIT }
			)
		: [];
	// How closely a decision is about this week: itself, its block, or (a run-up's) a week of it.
	const closeness = (row: (typeof rows)[number]) =>
		row.affected.includes(week.lineageId)
			? 0
			: row.affected.includes(block.lineageId)
				? 1
				: RUN_UP.includes(row.kind)
					? 2
					: null;
	// Between as close decisions, the run-up of this week's event: the nearest event on or after
	// its Monday (a block can hold a second event's mini-taper, logged after its own taper).
	const ahead = (row: (typeof rows)[number]) =>
		row.date && row.date >= week.startsOn ? row.date : '9999-12-31';
	let why: string = WEEK_KIND_WHY[week.kind];
	for (const kinds of tiers) {
		// Rows come newest first, and the sort is stable.
		const best = rows
			.filter((row) => kinds.includes(row.kind) && closeness(row) !== null)
			.toSorted((a, b) => closeness(a)! - closeness(b)! || ahead(a).localeCompare(ahead(b)))[0];
		if (best) {
			why = best.summary;
			break;
		}
	}
	const countdown = countdownOf(goals, today);
	const line = { label: WEEK_LINE_LABEL[week.kind], why, ...(countdown && { countdown }) };
	return { line, marks };
}
