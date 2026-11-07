/**
 * What History renders on the server, in words: the active program's versions newest first,
 * HISTORY_PAGE_SIZE at a time (getVersionHistory), and any one version as a read-only week. Kept
 * out of +page.server.ts so integration tests can run it with an unreachable database.
 *
 * - /train/history lists the versions: each one's number, when it was made (in the owner's time
 *   zone), who made it (DECIDER_LABEL) and every decision with its why. `?before=n` is the page
 *   below version n, the cursor a page gives: 'Show older versions' reads it without navigating
 *   (preloadData), so the route ships no form-action client. A malformed cursor is the first page.
 * - /train/history/<n> is version n: its decisions and one week of it, read-only, whose sessions
 *   open at that version (/train/session/<lineage>?v=n). A malformed or unknown version is the
 *   404 page in the shell. The route has no param matcher, which would cost every route
 *   JavaScript (docs/performance.md).
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
import type { IconName } from '#lib/ui/icons/icons.ts';
import { shortDate, type StripDayView } from '#lib/ui/program/words.ts';
import { weekWords, type TrainDay } from '../../cards.server';

/**
 * A version number in the path: a whole number from 1, as History links to it. Decision (m3
 * plan): anything else names no version, so it is not found, as an unknown version is.
 */
const VERSION_PARAM = /^[1-9]\d{0,9}$/;
/** A cursor in ?before: a version number as the path takes one; anything else is ignored. */
const CURSOR_PARAM = VERSION_PARAM;

/**
 * A state History shows as an EmptyState, in words composed here, so they cost the screen no
 * JavaScript: its test id, glyph, tone, title and guidance.
 */
export interface HistoryCard {
	id: 'history-empty' | 'history-none' | 'history-error';
	icon: IconName;
	tone: 'accent' | 'neutral' | 'combat';
	title: string;
	description: string;
}

/** Only version 1: nothing has changed yet. */
export const NO_CHANGES: HistoryCard = {
	id: 'history-empty',
	icon: 'clock',
	tone: 'neutral',
	title: 'No changes yet',
	description:
		'When you or your coach change your plan, each change is listed here with why it was made, and every earlier version stays viewable.'
};

export const NO_PROGRAM: HistoryCard = {
	id: 'history-none',
	icon: 'train',
	tone: 'accent',
	title: 'No program yet',
	description:
		'Each change to your program is listed here, with why it was made, once you have one.'
};

export const HISTORY_ERROR: HistoryCard = {
	id: 'history-error',
	icon: 'alert',
	tone: 'combat',
	title: 'Couldn’t load your history',
	description: 'Your plan is safe. Check your connection, then try again.'
};

/** A decision as History lists it. */
export interface DecisionItemView {
	id: string;
	/** What it decided; null when the version's summary already says it (an edit's one decision). */
	summary: string | null;
	/** Why, never empty. */
	why: string;
}

/** A version as History lists it. */
export interface VersionRowView {
	number: number;
	/** 'Mon 2 Nov · 09:15', in the owner's time zone. */
	when: string;
	/** Who made it: 'You', 'Coach', 'Programming rules'. */
	by: string;
	summary: string;
	current: boolean;
	decisions: DecisionItemView[];
}

/** One page of the list, and the cursor for the next (?before): null once version 1 is listed. */
export interface HistoryPageView {
	versions: VersionRowView[];
	next: number | null;
}

/** A version's week in words, as Train shows a week, read-only. */
export interface VersionWeekView {
	/** 'Baseline week · Week 1'. */
	label: string;
	strip: StripDayView[];
	days: TrainDay[];
	/** The day it opens on, Monday 0. */
	selected: number;
}

export type HistoryData =
	| { state: 'list'; page: HistoryPageView; empty: HistoryCard | null }
	| { state: 'version'; version: VersionRowView; today: IsoDate; week: VersionWeekView }
	| { state: 'none' | 'error'; card: HistoryCard };

export interface HistoryRequest {
	/** The route's optional [[version]], as given. */
	version: string | undefined;
	/** The ?before cursor, as given. */
	before: string | null;
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

function rowView(entry: VersionHistoryEntry, timeZone: string): VersionRowView {
	return {
		number: entry.number,
		when: whenWords(entry.createdAt, timeZone),
		by: DECIDER_LABEL[entry.createdBy],
		summary: entry.summary,
		current: entry.current,
		decisions: entry.decisions.map((d) => ({
			id: d.id,
			summary: d.summary === entry.summary ? null : d.summary,
			why: d.why
		}))
	};
}

const pageView = (history: VersionHistory, timeZone: string): HistoryPageView => ({
	versions: history.versions.map((entry) => rowView(entry, timeZone)),
	next: history.nextCursor
});

/**
 * The week a version opens on, and its day. Decision: an edit (version 2 on) opens where it
 * changed, on the day of the first session it touched there; version 1, which changed no one
 * session, opens on the week that holds today (week 1 before the start, as Train does) and its
 * first session's day. A week past the planned weeks opens on week 1 instead.
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
	let week: TrainingWeek | null = await getVersionWeek(
		ownerId,
		entry.number,
		{ date: touched ?? today },
		{ db }
	);
	if (week && !week.planned) {
		week = await getVersionWeek(ownerId, entry.number, { block: 1, week: 1 }, { db });
	}
	// getVersionHistory listed this version a moment ago; only a concurrent archive removes it.
	if (!week?.planned) throw new Error('the version’s week disappeared while History loaded');
	const days = week.days.map((d) => d.date);
	const opens = touched ?? (days.includes(today) ? today : undefined);
	const first = week.days.findIndex((d) => d.sessions.length > 0);
	return {
		label: `${week.blockName} · Week ${week.number}`,
		...weekWords(week, today),
		selected: opens ? days.indexOf(opens) : Math.max(0, first)
	};
}

export async function loadHistory(
	ownerId: string,
	{ version, before, now, origin }: HistoryRequest,
	{ db, errorsDb }: HistoryLoadDeps = {}
): Promise<HistoryData> {
	if (version !== undefined && !VERSION_PARAM.test(version)) error(404, 'Not found');
	try {
		if (version === undefined) {
			const cursor = before !== null && CURSOR_PARAM.test(before) ? Number(before) : undefined;
			const history = await getVersionHistory(ownerId, { before: cursor }, { db });
			if (!history) return { state: 'none', card: NO_PROGRAM };
			const { timeZone } = await getAthleteProfile(ownerId, { db });
			const page = pageView(history, timeZone);
			const unchanged = cursor === undefined && page.next === null && page.versions.length === 1;
			return { state: 'list', page, empty: unchanged ? NO_CHANGES : null };
		}
		const number = Number(version);
		// The page from just below `number + 1` starts with version `number`, when there is one.
		const history = await getVersionHistory(ownerId, { before: number + 1 }, { db });
		const entry = history?.versions[0];
		if (entry?.number !== number) throw new TrainingNotFoundError('program version');
		const { timeZone } = await getAthleteProfile(ownerId, { db });
		// The owner's today, as ownerToday gives it, from the profile already read.
		const today = localDay(now, timeZone);
		return {
			state: 'version',
			version: rowView(entry, timeZone),
			today,
			week: await versionWeek(ownerId, entry, today, db)
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
