/**
 * What the reviews screen (/progress/reviews/[[key]]) renders on the server (+page.server.ts),
 * kept apart so a test, and analytics-explain's timing, run the real load. The review services
 * give the stored reviews and the week that is due; this module arranges them into the list the
 * screen shows and the selected review's view, every figure from its stored snapshot.
 *
 * - The key is 'w-YYYY-MM-DD' (a weekly review, by its Monday), 'c-<uuid>' (a cycle review) or
 *   absent (the list alone). A malformed key, a week with no review and, until the cycle review
 *   screen adds its view, any cycle key are the 404 page in the shell.
 * - The list is newest first: this week while it has no review (due once every session is done
 *   or skipped, otherwise in progress), then each week back to the oldest review on the page,
 *   reviewed or 'Not reviewed yet'.
 * - Next week's card (nextWeekView): the changes still open with each one's why, its half step
 *   and whether its session has passed, or what was decided, or why nothing is proposed.
 * - It fails soft: a failed read is recorded as a server error (kind 'load') and the screen shows
 *   its load-failed notice with Retry, inside the shell, instead of the 500 page.
 */
import { error } from '@sveltejs/kit';
import { addDays, mondayOf, parseIsoDate, weekdayOf, type IsoDate } from '#lib/domain/calendar.ts';
import type { ProgramOp } from '#lib/domain/coach/proposals.ts';
import { cleanFloat } from '#lib/domain/units.ts';
import { WEEKDAY_INFO } from '#lib/domain/weekdays.ts';
import { METRICS } from '#lib/domain/analytics/metrics.ts';
import { TREND_MIN_POINTS } from '#lib/domain/analytics/trend.ts';
import type { Finding, FindingLevel } from '#lib/domain/programming/review/brief.ts';
import { ownerToday } from '#lib/server/local-date.ts';
import { recordServerError, type ServerErrorInput } from '#lib/server/services/errors.ts';
import { isUuid } from '#lib/server/services/ids.ts';
import {
	createWeeklyReview,
	getWeeklyReviewView,
	listReviews,
	nextWeekOffers,
	REVIEWS_PAGE,
	ReviewInputError,
	ReviewNotFoundError,
	ReviewSupersededError,
	REFRESHABLE,
	refreshWeeklyReview,
	reviewableWeek,
	WeeklyReviewRefreshError,
	WeeklyReviewNotReviewableError,
	type NextWeekOffer,
	type WeeklyReviewView
} from '#lib/server/services/reviews/index.ts';
import type { TrainingDeps } from '#lib/server/services/training/shared.ts';
import type { TileVerdict } from '#lib/ui/analytics/verdict-words.ts';
import { shortDate } from '#lib/ui/program/words.ts';
import { slotOf } from '../../load.ts';
import { reviewSections, type SectionView } from './sections.ts';

/** The reviews one list shows: a page of the store's largest, about a year of weeks. */
export const LIST_LIMIT = REVIEWS_PAGE.max;

/** At most this many older weeks with no review are listed, each with its Create. */
export const NOT_REVIEWED_MAX = 8;

export type ReviewKey = { kind: 'weekly'; weekStartsOn: IsoDate } | { kind: 'cycle'; id: string };

/** A key from the URL: null when absent, undefined when malformed. */
export function parseReviewKey(key: string | undefined): ReviewKey | null | undefined {
	if (key === undefined) return null;
	const [prefix, rest] = [key.slice(0, 2), key.slice(2)];
	if (prefix === 'w-' && parseIsoDate(rest) !== null && mondayOf(rest) === rest)
		return { kind: 'weekly', weekStartsOn: rest };
	if (prefix === 'c-' && isUuid(rest)) return { kind: 'cycle', id: rest };
	return undefined;
}

export const weeklyKey = (weekStartsOn: IsoDate) => `w-${weekStartsOn}`;

export interface ReviewRow {
	/** reviewed; due: reviewable now; in_progress: this week, not yet; not_reviewed: an older week. */
	state: 'reviewed' | 'due' | 'in_progress' | 'not_reviewed';
	key: string;
	weekStartsOn: IsoDate;
	/** 'Week of 2 Nov'. */
	title: string;
	/** The review's summary, or what the row's state means. */
	text: string;
}

export interface TrendView {
	id: string;
	label: string;
	verdict: TileVerdict;
	/** The stored verdict's words ('Trending up, improving'). */
	words: string;
	/** The change along the trend, in words ('5 kg'); null when none was measured. */
	change: string | null;
	context: { period: string; good: string; method: string; caveat: string | null };
}

export interface WeeklyReviewData {
	kind: 'weekly';
	/** The live revision's id, which Refresh posts. */
	id: string;
	key: string;
	weekStartsOn: IsoDate;
	title: string;
	/** 'Mon 2 Nov – Sun 8 Nov'. */
	dates: string;
	summary: string;
	/** Written before M6: only the summary is shown. */
	legacy: boolean;
	/** Planned against completed, from the snapshot; null for a legacy review. */
	adherence: {
		/** Completed of due, in percentage points; null with nothing due. */
		pct: number | null;
		/** '83%', or null with nothing due. */
		text: string | null;
		level: FindingLevel;
		words: string;
		counts: { label: string; value: number; words: string }[];
	} | null;
	trends: TrendView[];
	/** Verdict findings that are not trends (a baseline week). */
	notes: { id: string; label: string; words: string }[];
	/** RPE, volume, running, Muay Thai, recovery and fatigue, conflicts and PRs (sections.ts). */
	sections: SectionView[];
	/**
	 * Facts changed since it was computed: how many, in words, and whether Refresh may write its
	 * next revision (only while the decision is open; a decided review never changes). Null when
	 * it is up to date.
	 */
	stale: { words: string; detail: string; refreshable: boolean } | null;
	/** The coach's write-up once written (review-narrative-ui); null leaves its slot empty. */
	writeUp: string | null;
	/** Next week's card; null for a review written before M6. */
	nextWeek: NextWeekView | null;
}

/** One change the owner can take, change or leave out. */
export interface NextWeekItemView {
	id: string;
	label: string;
	before: string | null;
	after: string | null;
	why: string;
	/** Its half step in words ('86.25 kg'); null when it has none. */
	half: string | null;
	/** Why it can no longer change ('Monday has passed'); null while its session is ahead. */
	passed: string | null;
}

/**
 * What next week's card shows, from the review's decision (its proposal chain's head):
 * - open: undecided; partly_past: decided late or superseded from M5's inbox, with what is left;
 *   all_past: every change's session has passed
 * - no_ops, no_program, boundary, late: nothing was proposed, and why
 * - applied (from here or M5's inbox), rejected, superseded (the plan changed), waiting
 */
export interface NextWeekView {
	state:
		| 'open'
		| 'partly_past'
		| 'all_past'
		| 'no_ops'
		| 'no_program'
		| 'boundary'
		| 'late'
		| 'applied'
		| 'rejected'
		| 'superseded'
		| 'waiting';
	title: string;
	words: string | null;
	/** The changes to decide on (open and partly_past; all_past lists them struck through). */
	items: NextWeekItemView[];
	/** The changes the rules found but could not propose, each with why. */
	notProposed: { id: string; label: string; words: string }[];
	link: { href: string; label: string } | null;
}

export type ReviewsData =
	| { failed: true; key: string | null }
	| {
			failed: false;
			key: string | null;
			rows: ReviewRow[];
			/** No review stored yet. */
			empty: boolean;
			selected: WeeklyReviewData | null;
	  };

export interface ReviewsRequest {
	key: string | undefined;
	origin: Pick<ServerErrorInput, 'requestId' | 'method' | 'path' | 'routeId' | 'appVersion'>;
}

export interface ReviewsDeps extends Pick<TrainingDeps, 'db'> {
	/** Where a failure is recorded (app_errors): the app's database unless given. */
	errorsDb?: TrainingDeps['db'];
	list?: typeof listReviews;
	view?: typeof getWeeklyReviewView;
	offers?: typeof nextWeekOffers;
	reviewable?: typeof reviewableWeek;
	record?: typeof recordServerError;
	today?: typeof ownerToday;
}

const titleOf = (weekStartsOn: IsoDate) =>
	slotOf({ at: weekStartsOn, value: null, inProgress: false }, 'week').label;

const STATE_TEXT = {
	due: 'Ready to review',
	in_progress: 'In progress · ready after Sunday, or once every session is done or skipped',
	not_reviewed: 'Not reviewed yet'
} as const;

/**
 * The list, newest first, from this week back to the oldest review given (last week with none).
 * `due` is the week the services say is reviewable now.
 */
export function reviewRows(
	reviews: readonly { weekStartsOn: IsoDate; summary: string }[],
	due: IsoDate | null,
	today: IsoDate
): ReviewRow[] {
	const byWeek = new Map(reviews.map((r) => [r.weekStartsOn, r]));
	const thisWeek = mondayOf(today);
	const oldest = [addDays(thisWeek, -7), ...byWeek.keys()].sort()[0]!;
	const rows: ReviewRow[] = [];
	let unreviewed = 0;
	for (let week = thisWeek; week >= oldest; week = addDays(week, -7)) {
		const review = byWeek.get(week);
		const base = { key: weeklyKey(week), weekStartsOn: week, title: titleOf(week) };
		if (review) rows.push({ ...base, state: 'reviewed', text: review.summary });
		else {
			const state = week === due ? 'due' : week === thisWeek ? 'in_progress' : 'not_reviewed';
			if (state === 'not_reviewed' && ++unreviewed > NOT_REVIEWED_MAX) continue;
			rows.push({ ...base, state, text: STATE_TEXT[state] });
		}
	}
	return rows;
}

/** 'Trending up, improving' as a VerdictBadge says it; the words are trendCall's (review/weekly.ts). */
export function findingVerdict(finding: Finding): TileVerdict {
	const { level, words } = finding.verdict;
	if (level === 'not_enough_data') {
		const more = Number(/(\d+) more week/.exec(words)?.[1] ?? TREND_MIN_POINTS);
		// '0 more weeks' (enough weeks, too short a span) still lacks one: never 'have of have'.
		const have = Math.min(TREND_MIN_POINTS - 1, Math.max(0, TREND_MIN_POINTS - more));
		return { verdict: 'insufficient_data', have, need: TREND_MIN_POINTS, unit: 'weeks' };
	}
	const way = /Trending (up|down)/.exec(words)?.[1];
	const change = finding.figures[0]?.value ?? 0;
	const direction = way === 'up' || (way === undefined && change > 0) ? 'up' : 'down';
	if (level === 'good') return { verdict: 'real_trend', direction, good: true };
	if (level === 'watch' || level === 'low')
		return { verdict: 'real_trend', direction, good: false };
	if (way) return { verdict: 'real_trend', direction, good: null };
	return { verdict: 'normal_variation' };
}

/** An out-of-date review's notice: Refresh only while its decision is open. */
export function staleNotice(changes: number, refreshable: boolean) {
	return {
		words: `Computed before ${changes} later ${changes === 1 ? 'change' : 'changes'}`,
		detail: refreshable
			? 'You’ve logged training since. Refresh recomputes it and keeps this version.'
			: 'You’ve decided on its changes, so it stays as it was.',
		refreshable
	};
}

/** Where next week's card links: the build is on Today. */
export const BUILD_LINK = { href: '/today', label: 'Build my program' };
/** Decision: the reviews list, until cycle-review-screen gives each cycle review its key. */
export const CYCLE_REVIEW_LINK = { href: '/progress/reviews', label: 'Open your cycle review' };

export const NEXT_WEEK_TITLES: Record<NextWeekView['state'], string> = {
	open: 'Next week’s changes',
	partly_past: 'Some sessions have passed — apply the rest?',
	all_past: 'Too late to change next week',
	no_ops: 'Next week stays as planned',
	no_program: 'Build a program to get adjustments',
	boundary: 'Next week starts a new block',
	late: 'This review came after next week ended',
	applied: 'Next week updated',
	rejected: 'Kept as planned',
	superseded: 'Your plan changed since this review',
	waiting: 'Accepted · being applied'
};

const NO_PROPOSAL_STATE = { no_changes: 'no_ops', boundary: 'boundary', late: 'late' } as const;

/** The card's own words with no program: the stored ones can name the cycle review instead. */
const NO_PROGRAM_WORDS =
	'No program plans next week. Once one does, each review proposes its changes here.';

/** Why a change can no longer apply: its day has passed, or its session has begun. */
function passedWords(date: IsoDate | null, today: IsoDate): string {
	if (date === null) return 'Its session has passed';
	const day = WEEKDAY_INFO[weekdayOf(date)].label;
	return date < today ? `${day} has passed` : `${day}’s session has started`;
}

/** A half step's values in words, in the units its row's 'after' uses ('86.25 kg · RPE 7.5'). */
export function halfWords(op: ProgramOp, after: string | null): string {
	const v = op as unknown as Partial<Record<string, number>>;
	const load = /\b(kg|lb)\b/.exec(after ?? '')?.[1] ?? 'kg';
	const miles = /\bmi\b/.test(after ?? '');
	const reps =
		v.repsMin !== undefined && v.repsMax !== undefined && v.repsMin !== v.repsMax
			? `${v.repsMin}–${v.repsMax}`
			: (v.repsMax ?? v.repsMin);
	const metres = v.distanceMetres;
	return [
		v.sets !== undefined && `${v.sets} sets`,
		reps !== undefined && `${reps} reps`,
		v.loadValue !== undefined && `${v.loadValue} ${load}`,
		v.targetRpe !== undefined && `RPE ${v.targetRpe}`,
		metres !== undefined &&
			(miles ? `${cleanFloat(metres / 1609.344, 2)} mi` : `${cleanFloat(metres / 1000, 2)} km`),
		v.durationSeconds !== undefined && `${Math.round(v.durationSeconds / 60)} min`
	]
		.filter(Boolean)
		.join(' · ');
}

/**
 * Next week's card from the review's decision: the head's changes (`offers`, split on the owner's
 * `today`) while it is open, what was decided, or why nothing was proposed.
 */
export function nextWeekView(
	view: WeeklyReviewView,
	offers: readonly NextWeekOffer[],
	today: IsoDate
): NextWeekView | null {
	if (view.legacy) return null;
	const { decision, proposal } = view;
	const card = (state: NextWeekView['state'], words: string | null, more = {}): NextWeekView => ({
		...{ state, title: NEXT_WEEK_TITLES[state], words, items: [] },
		notProposed: view.notProposed.map((f) => ({
			id: f.id,
			label: f.label,
			words: f.verdict.words
		})),
		link: null,
		...more
	});
	switch (decision.state) {
		case 'none': {
			if (!view.noProposal) return null;
			const { reason, words } = view.noProposal;
			if (reason === 'no_program')
				return card('no_program', NO_PROGRAM_WORDS, { link: BUILD_LINK });
			const link = reason === 'boundary' ? CYCLE_REVIEW_LINK : null;
			return card(NO_PROPOSAL_STATE[reason], words, { link });
		}
		case 'applied': {
			const n = decision.versionNumber;
			return card('applied', null, {
				title: n === null ? NEXT_WEEK_TITLES.applied : `Next week updated · version ${n}`,
				link:
					n === null ? null : { href: `/train/history/${n}`, label: `See version ${n} in History` }
			});
		}
		case 'rejected':
			return card('rejected', proposal?.decisionNote ?? 'Next week stays as planned.');
		case 'superseded':
			return card(
				'superseded',
				'Its changes were for your plan as it was, so none were applied. Next week stays as it is now.'
			);
		case 'accepted_waiting':
			return card('waiting', 'Your plan is being updated.');
		default: {
			const rows = proposal?.rows ?? [];
			const items = offers.map((o, i): NextWeekItemView => {
				const row = rows[i];
				return {
					id: o.id,
					label: row?.label ?? 'Change',
					before: row?.before ?? null,
					after: row?.after ?? null,
					why: o.why ?? '',
					half: o.halfStep && halfWords(o.halfStep, row?.after ?? null),
					passed: o.ahead ? null : passedWords(o.sessionDate, today)
				};
			});
			const passed = items.filter((item) => item.passed).length;
			if (passed === items.length)
				return card(
					'all_past',
					'Every change was for a session that has passed, so next week stays as planned.',
					{ items }
				);
			if (passed === 0 && decision.state === 'undecided') return card('open', null, { items });
			const left = items.length - passed;
			const words = `${left} of ${items.length} ${items.length === 1 ? 'change is' : 'changes are'} still ahead.`;
			return card('partly_past', words, { items });
		}
	}
}

/** A weekly review as the screen shows it, every figure from its stored snapshot. */
export function weeklyReviewData(
	view: WeeklyReviewView,
	offers: readonly NextWeekOffer[] = [],
	today: IsoDate = view.review.weekStartsOn
): WeeklyReviewData {
	const { weekStartsOn } = view.review;
	const findings = view.snapshot?.brief.findings ?? [];
	const adherence = findings.find((f) => f.id === 'adherence');
	const verdicts = findings.filter((f) => f.section === 'verdicts');
	const pct = view.snapshot?.adherence.pct ?? null;
	const changes = view.laterChanges;
	return {
		kind: 'weekly',
		id: view.review.id,
		key: weeklyKey(weekStartsOn),
		weekStartsOn,
		title: titleOf(weekStartsOn),
		dates: `${shortDate(weekStartsOn)} – ${shortDate(addDays(weekStartsOn, 6))}`,
		summary: view.review.summary,
		legacy: view.legacy,
		adherence:
			view.snapshot && adherence
				? {
						pct,
						text:
							pct === null
								? null
								: (adherence.figures.find((f) => f.label === 'Adherence')?.words ?? null),
						level: adherence.verdict.level,
						words: adherence.verdict.words,
						counts: adherence.figures
							.filter((f) => f.unit === 'sessions')
							.map((f) => ({ label: f.label, value: f.value ?? 0, words: f.words }))
					}
				: null,
		trends: verdicts.flatMap((f): TrendView[] => {
			if (f.metricId === null) return [];
			const metric = METRICS[f.metricId];
			const change = f.figures[0];
			return [
				{
					id: f.id,
					label: f.label,
					verdict: findingVerdict(f),
					words: f.verdict.words,
					change: change && change.value !== null ? change.words : null,
					context: {
						period: f.window?.label ?? 'This week',
						good: metric.good.words,
						method: metric.method,
						caveat: metric.caveat
					}
				}
			];
		}),
		notes: verdicts
			.filter((f) => f.metricId === null)
			.map((f) => ({ id: f.id, label: f.label, words: f.verdict.words })),
		sections: view.snapshot ? reviewSections(view.snapshot) : [],
		stale: view.stale ? staleNotice(changes, REFRESHABLE.includes(view.decision.state)) : null,
		writeUp: view.writeUp.state === 'written' ? view.writeUp.text : null,
		nextWeek: nextWeekView(view, offers, today)
	};
}

/** The decisions whose changes the card lists for deciding. */
const OPEN: readonly string[] = ['undecided', 'partly_past'];

/** The reviews screen on the owner's day at `now`: 404 for a bad key, failing soft otherwise. */
export async function loadReviews(
	ownerId: string,
	{ key, origin }: ReviewsRequest,
	now: Date,
	{
		db,
		errorsDb,
		list = listReviews,
		view = getWeeklyReviewView,
		offers = nextWeekOffers,
		reviewable = reviewableWeek,
		record = recordServerError,
		today: dayOf = ownerToday
	}: ReviewsDeps = {}
): Promise<ReviewsData> {
	const parsed = parseReviewKey(key);
	// No cycle view yet: cycle-review-screen adds it, with its VIEWS entry in +page.ts.
	if (parsed === undefined || parsed?.kind === 'cycle') error(404, 'Not found');
	try {
		const today = await dayOf(ownerId, now, { db });
		// One query at a time: each read finishes before the next starts.
		const page = await list(ownerId, { limit: LIST_LIMIT }, { db });
		const due = await reviewable(ownerId, today, { db });
		const weekly = page.items.flatMap((item) =>
			item.kind === 'weekly' && item.startsOn
				? [{ weekStartsOn: item.startsOn, summary: item.summary }]
				: []
		);
		const shown = parsed && (await view(ownerId, parsed.weekStartsOn, { db }));
		const open = shown && OPEN.includes(shown.decision.state) && shown.proposal;
		const offered = open ? await offers(ownerId, open.id, today, { db }) : [];
		const selected = shown && weeklyReviewData(shown, offered, today);
		return {
			failed: false,
			key: key ?? null,
			rows: reviewRows(weekly, due?.weekStartsOn ?? null, today),
			empty: weekly.length === 0,
			selected
		};
	} catch (err) {
		if (err instanceof ReviewNotFoundError) error(404, 'Not found');
		await record(
			{
				...{ error: err, kind: 'load', status: 500, ...origin },
				context: { load: 'progress-reviews', key: key ?? null }
			},
			{ db: errorsDb }
		);
		return { failed: true, key: key ?? null };
	}
}

export type CreateResult =
	| { ok: true; key: string }
	| {
			ok: false;
			status: 400 | 409;
			data: {
				reason: 'invalid' | 'not_reviewable';
				weekStartsOn: string;
				availableOn?: IsoDate;
				ready?: string;
			};
	  };

export interface CreateDeps extends Pick<TrainingDeps, 'db'> {
	create?: typeof createWeeklyReview;
	today?: typeof ownerToday;
}

/**
 * Create the review of the week from `weekStartsOn`, or find the one already there: the service
 * is idempotent under the owner's review lock, so a second tap opens the same review. A week that
 * is not reviewable yet is a 409 with the day it will be; any other failure throws (a 500).
 */
export async function createReview(
	ownerId: string,
	weekStartsOn: string,
	now: Date,
	{ db, create = createWeeklyReview, today: dayOf = ownerToday }: CreateDeps = {}
): Promise<CreateResult> {
	const today = await dayOf(ownerId, now, { db });
	try {
		const { review } = await create(ownerId, { weekStartsOn, today }, { db });
		return { ok: true, key: weeklyKey(review.weekStartsOn) };
	} catch (err) {
		if (err instanceof WeeklyReviewNotReviewableError) {
			const { availableOn } = err;
			const ready = `Ready ${shortDate(availableOn)}`;
			return {
				ok: false,
				status: 409,
				data: { reason: 'not_reviewable', weekStartsOn, availableOn, ready }
			};
		}
		if (err instanceof ReviewInputError)
			return { ok: false, status: 400, data: { reason: 'invalid', weekStartsOn } };
		throw err;
	}
}

export type RefreshResult =
	| { ok: true }
	| { ok: false; status: 400 | 409; data: { reason: 'invalid' | 'decided' | 'not_ready' } };

export interface RefreshDeps extends Pick<TrainingDeps, 'db'> {
	refresh?: typeof refreshWeeklyReview;
	today?: typeof ownerToday;
}

/**
 * Refresh the review `id`: its next revision, recomputed from today's facts, with both rows kept.
 * Already up to date, or refreshed by another tap first (superseded), is done all the same: the
 * page then shows the live revision. A decided review is a 409, since it never changes, and so is
 * an early review whose week is no longer done before it ends (not reviewable until Monday); an
 * unknown id a 400; any other failure throws (a 500).
 */
export async function refreshReview(
	ownerId: string,
	id: string,
	now: Date,
	{ db, refresh = refreshWeeklyReview, today: dayOf = ownerToday }: RefreshDeps = {}
): Promise<RefreshResult> {
	const today = await dayOf(ownerId, now, { db });
	try {
		await refresh(ownerId, id, { today }, { db });
		return { ok: true };
	} catch (err) {
		if (err instanceof WeeklyReviewRefreshError && err.reason === 'decided')
			return { ok: false, status: 409, data: { reason: 'decided' } };
		if (err instanceof WeeklyReviewNotReviewableError)
			return { ok: false, status: 409, data: { reason: 'not_ready' } };
		if (err instanceof WeeklyReviewRefreshError || err instanceof ReviewSupersededError)
			return { ok: true };
		if (err instanceof ReviewNotFoundError || err instanceof ReviewInputError)
			return { ok: false, status: 400, data: { reason: 'invalid' } };
		throw err;
	}
}
