/**
 * What Changes (History, Instrument v2: Paper 4 · Train "What has changed") renders on the server,
 * in words: the active program's versions newest first, HISTORY_PAGE_SIZE at a time
 * (getVersionHistory), each a change, and any one change with the week as it was before it. Kept
 * out of +page.server.ts so integration tests can run it with an unreachable database.
 *
 * - /train/history lists the changes: each one's summary and day ('Today', '12 Nov', in the
 *   owner's time zone), and how many there have been. Version 1 is 'Plan created', and no change.
 *   `?before=n` is the page below version n, the cursor a page gives: 'Show older changes' reads it
 *   without navigating (preloadData), so the route ships no form-action client. A malformed
 *   cursor is the first page.
 * - /train/history/<n> is version n's change: when, who made it (DECIDER_LABEL) and each
 *   decision's why, with the list's first page, which a desktop window shows beside it (split), so
 *   picking a change keeps the list. A malformed or unknown version is the 404 page in the shell.
 *   The route has no param matcher, which would cost every route JavaScript (docs/performance.md).
 * - /train/history/<n>?week is the week as it was before that change: version n − 1's week, on
 *   the day the change touched, read-only, whose sessions open at that version
 *   (/train/session/<lineage>?v=n−1). Version 1 shows itself, as first planned. Only this read
 *   reads a week.
 * - It fails soft: a read that fails is recorded as a server error (kind 'load') and History
 *   shows its designed error with Retry, inside the shell, instead of the 500 page.
 */
import { error, isHttpError } from '@sveltejs/kit';
import type { IsoDate } from '#lib/domain/calendar.ts';
import { localDay } from '#lib/domain/dates.ts';
import { DECIDER_LABEL } from '#lib/domain/training/vocabulary.ts';
import { recordServerError, type ServerErrorInput } from '#lib/server/services/errors.ts';
import { getAthleteProfile } from '#lib/server/services/profile/index.ts';
import {
	getVersionHistory,
	getVersionWeek,
	type TrainingWeek,
	type VersionHistory,
	type VersionHistoryEntry
} from '#lib/server/services/programs/index.ts';
import {
	TrainingInputError,
	TrainingNotFoundError,
	type TrainingDeps
} from '#lib/server/services/training/shared.ts';
import { changeDay, changesCount, weekLines, type WeekLine } from '#lib/ui/program/week-lines.ts';
import { shortDate } from '#lib/ui/program/words.ts';

/**
 * A version number in the path: a whole number from 1, as History links to it. Decision (m3
 * plan): anything else names no version, so it is not found, as an unknown version is.
 */
const VERSION_PARAM = /^[1-9]\d{0,9}$/;
/** A cursor in ?before: a version number as the path takes one; anything else is ignored. */
const CURSOR_PARAM = VERSION_PARAM;

/**
 * A state Changes shows as a statement (Paper, 4 · Train "No week to show"), in words composed
 * here, so they cost the screen no JavaScript: its test id, its title (none for 'no changes', a
 * sentence under the list) and its sentence.
 */
export interface HistoryCard {
	id: 'history-empty' | 'history-none' | 'history-error' | 'history-bridge';
	title: string | null;
	description: string;
}

/** Only version 1: nothing has changed yet. */
export const NO_CHANGES: HistoryCard = {
	id: 'history-empty',
	title: null,
	description: 'Every move, swap and skip is kept here, with who made it and why.'
};

export const NO_PROGRAM: HistoryCard = {
	id: 'history-none',
	title: 'No plan yet',
	description: 'Each change to your plan is kept here once you have one.'
};

export const HISTORY_ERROR: HistoryCard = {
	id: 'history-error',
	title: 'Couldn’t load your history',
	description: 'Your plan is safe. Check your connection and try again.'
};

/** A bridge week: unplanned, and the day the next block starts. */
const bridgeCard = (startsOn: IsoDate): HistoryCard => ({
	id: 'history-bridge',
	title: 'Unplanned week · between blocks',
	description: `The next block starts ${shortDate(startsOn)}. Nothing was planned this week: what was logged counts as off-plan.`
});

/** Version 1 in the list: the plan's start, not a change (Paper). */
export const PLAN_CREATED = 'Plan created';

/** A decision as a change shows it. */
export interface DecisionItemView {
	id: string;
	/** What it decided; null when the version's summary already says it (an edit's one decision). */
	summary: string | null;
	/** Why, never empty. */
	why: string;
}

/** A version as Changes lists it, and as its change shows it. */
export interface VersionRowView {
	number: number;
	/** The day it was made, in the owner's time zone. */
	date: IsoDate;
	/** That day as the list says it: 'Today', 'Yesterday', '12 Nov'. */
	day: string;
	/** 'Mon 2 Nov · 09:15', in the owner's time zone. */
	when: string;
	/** Who made it: 'You', 'Coach', 'Programming rules'. */
	by: string;
	/** What changed; version 1's is 'Plan created'. */
	summary: string;
	/** Version 1's own summary, when it says more than 'Plan created': 'Your first program'. */
	note: string | null;
	current: boolean;
	decisions: DecisionItemView[];
}

/** One page of the list, and the cursor for the next (?before): null once version 1 is listed. */
export interface HistoryPageView {
	versions: VersionRowView[];
	next: number | null;
}

/** The week as it was before a change, as Train's lines, read-only. */
export interface VersionWeekView {
	/** 'Baseline week · Week 1'. */
	label: string;
	/** The version it is: the one before the change, or version 1 itself. */
	version: number;
	/** Its sessions open at that version (?v=n); false when it is the current one. */
	older: boolean;
	lines: WeekLine[];
	/** A bridge week between blocks, in place of its seven rest lines: when the next block starts. */
	bridge?: HistoryCard;
}

export type HistoryData =
	| {
			state: 'list';
			page: HistoryPageView;
			/** 'Five since the plan began'; null on a ?before page, whose newest is not the newest. */
			count: string | null;
			empty: HistoryCard | null;
	  }
	| {
			state: 'version';
			version: VersionRowView;
			today: IsoDate;
			/** With ?week: the week as it was before the change. */
			week: VersionWeekView | null;
			/** The list's first page: a desktop window lists the changes beside this one. */
			page: HistoryPageView;
			/** The list's count, above it on a desktop window. */
			count: string;
	  }
	| { state: 'none' | 'error'; card: HistoryCard };

export interface HistoryRequest {
	/** The route's optional [[version]], as given. */
	version: string | undefined;
	/** The ?before cursor, as given. */
	before: string | null;
	/** ?week: the week as it was before the change. */
	week?: boolean;
	/** When the request came in: the owner's today, in their time zone, follows from it. */
	now: Date;
	/** What a recorded failure carries: the request's id, method, path, route and app version. */
	origin: Pick<ServerErrorInput, 'requestId' | 'method' | 'path' | 'routeId' | 'appVersion'>;
}

export interface HistoryLoadDeps extends Pick<TrainingDeps, 'db'> {
	/** Where a failure is recorded (app_errors): the app's database unless given. */
	errorsDb?: TrainingDeps['db'];
}

/** 'Mon 2 Nov · 09:15' in `timeZone`. */
function whenWords(at: Date, timeZone: string): string {
	const time = new Intl.DateTimeFormat('en-GB', {
		timeZone,
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23'
	}).format(at);
	return `${shortDate(localDay(at, timeZone))} · ${time}`;
}

function rowView(entry: VersionHistoryEntry, timeZone: string, today: IsoDate): VersionRowView {
	const date = localDay(entry.createdAt, timeZone);
	const first = entry.number === 1;
	return {
		number: entry.number,
		date,
		day: changeDay(date, today),
		when: whenWords(entry.createdAt, timeZone),
		by: DECIDER_LABEL[entry.createdBy],
		summary: first ? PLAN_CREATED : entry.summary,
		note: first && entry.summary !== PLAN_CREATED ? entry.summary : null,
		current: entry.current,
		decisions: entry.decisions.map((d) => ({
			id: d.id,
			summary: d.summary === entry.summary ? null : d.summary,
			why: d.why
		}))
	};
}

const pageView = (history: VersionHistory, timeZone: string, today: IsoDate): HistoryPageView => ({
	versions: history.versions.map((entry) => rowView(entry, timeZone, today)),
	next: history.nextCursor
});

/**
 * The week as it was before a change (v2/07b): version n − 1's week at the day the change
 * touched, the first of its sessions with a date. Version 1, which changed no one session, shows
 * itself on the week that holds today (week 1 before the start, as Train does). A week past the
 * planned weeks shows week 1 instead.
 */
async function versionWeek(
	ownerId: string,
	entry: VersionHistoryEntry,
	today: IsoDate,
	db: TrainingDeps['db']
): Promise<VersionWeekView> {
	const touched =
		entry.number > 1
			? entry.decisions.flatMap((d) => d.affected).find((node) => node.date !== null)?.date
			: undefined;
	const number = Math.max(1, entry.number - 1);
	let week: TrainingWeek | null = await getVersionWeek(
		ownerId,
		number,
		{ date: touched ?? today },
		{ db }
	);
	if (week && !week.planned) {
		week = await getVersionWeek(ownerId, number, { block: 1, week: 1 }, { db });
	}
	// getVersionHistory listed this version a moment ago; only a concurrent archive removes it.
	if (!week?.planned) throw new Error('the version’s week disappeared while History loaded');
	return {
		label: `${week.blockName} · Week ${week.number}`,
		version: number,
		older: number !== entry.number || !entry.current,
		lines: weekLines(week.days, today),
		...(week.nextBlockStartsOn && { bridge: bridgeCard(week.nextBlockStartsOn) })
	};
}

export async function loadHistory(
	ownerId: string,
	{ version, before, week = false, now, origin }: HistoryRequest,
	{ db, errorsDb }: HistoryLoadDeps = {}
): Promise<HistoryData> {
	if (version !== undefined && !VERSION_PARAM.test(version)) error(404, 'Not found');
	try {
		if (version === undefined) {
			const cursor = before !== null && CURSOR_PARAM.test(before) ? Number(before) : undefined;
			const history = await getVersionHistory(ownerId, { before: cursor }, { db });
			if (!history) return { state: 'none', card: NO_PROGRAM };
			const { timeZone } = await getAthleteProfile(ownerId, { db });
			// The owner's today, as ownerToday gives it, from the profile already read.
			const page = pageView(history, timeZone, localDay(now, timeZone));
			const unchanged = cursor === undefined && page.next === null && page.versions.length === 1;
			// The first page's newest is the newest: its number, less version 1, counts the changes.
			const newest = cursor === undefined ? (page.versions[0]?.number ?? 1) : null;
			return {
				state: 'list',
				page,
				count: newest === null ? null : changesCount(newest - 1),
				empty: unchanged ? NO_CHANGES : null
			};
		}
		const number = Number(version);
		// The list's first page, which a desktop window shows beside the version, and the version
		// itself from it; an older one is the page from just below `number + 1`, which starts with
		// version `number` when there is one.
		const first = await getVersionHistory(ownerId, {}, { db });
		let entry = first?.versions.find((v) => v.number === number);
		if (first && !entry) {
			const history = await getVersionHistory(ownerId, { before: number + 1 }, { db });
			entry = history?.versions[0];
		}
		if (!first || entry?.number !== number) throw new TrainingNotFoundError('program version');
		const { timeZone } = await getAthleteProfile(ownerId, { db });
		// The owner's today, as ownerToday gives it, from the profile already read.
		const today = localDay(now, timeZone);
		return {
			state: 'version',
			version: rowView(entry, timeZone, today),
			today,
			week: week ? await versionWeek(ownerId, entry, today, db) : null,
			page: pageView(first, timeZone, today),
			count: changesCount((first.versions[0]?.number ?? 1) - 1)
		};
	} catch (err) {
		if (isHttpError(err)) throw err;
		// A version past the last one a cursor can name is no version either.
		if (err instanceof TrainingNotFoundError || err instanceof TrainingInputError) {
			error(404, 'Not found');
		}
		await recordServerError(
			{ error: err, kind: 'load', status: 500, ...origin, context: { load: 'history' } },
			{ db: errorsDb }
		);
		return { state: 'error', card: HISTORY_ERROR };
	}
}
