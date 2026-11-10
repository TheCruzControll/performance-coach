/**
 * Source refs (PRD §12): the record a fact, metric or recommendation rests on, and what tapping it
 * does. Tool outputs carry full refs; an answer cites them inline as `[[type:id]]` or
 * `[[type:id|label]]` (domain/coach/answer.ts), which parseRef reads.
 *
 * sourceAction only ever builds an app path from fixed prefixes and an encoded id, so a ref can
 * never become an external, protocol-relative or traversing link, whatever id a tool or the model
 * supplies.
 */
import { mondayOf, parseIsoDate } from '../calendar.ts';

/** What a ref points at; the words name it in a source's accessible label. */
export const SOURCE_TYPE_LABEL = {
	workout: 'Workout',
	set: 'Set',
	run: 'Run',
	session: 'Planned session',
	version: 'Program version',
	decision: 'Programming decision',
	goal: 'Goal',
	baseline: 'Baseline',
	preference: 'Preference',
	proposal: 'Proposal',
	review: 'Review',
	note: 'Coach note',
	exercise: 'Exercise',
	pain_report: 'Pain report',
	date: 'Date'
};
export type SourceType = keyof typeof SOURCE_TYPE_LABEL;
export const SOURCE_TYPES = Object.keys(SOURCE_TYPE_LABEL) as readonly SourceType[];

export interface SourceRef {
	type: SourceType;
	/**
	 * The record's id. A version's id is its version number (what /train/history/[n] takes), a
	 * session's is its lineage key, a review's is its page key (reviewKey: `w-<Monday>` or
	 * `c-<id>`) and a date's is the day, `YYYY-MM-DD`.
	 */
	id: string;
	/** Short words for the record ('Mon 3 Nov squat'); never shown as a raw id. */
	label?: string;
	/** The day the record is dated, `YYYY-MM-DD`. */
	date?: string;
	/** For a set, a run or a pain report: the workout it was logged in, which History opens. */
	workoutId?: string;
}

export type SourceAction =
	{ kind: 'link'; href: string } | { kind: 'exercise_history'; exerciseId: string };

/** The longest id and label an answer may cite inline. */
export const REF_ID_MAX = 80;
export const REF_LABEL_MAX = 80;

const REF = new RegExp(
	`^([a-z_]+):([A-Za-z0-9][A-Za-z0-9._-]{0,${REF_ID_MAX - 1}})(?:\\|([^\\[\\]|\\n]{0,${REF_LABEL_MAX}}))?$`
);

export function isSourceType(value: string): value is SourceType {
	return Object.hasOwn(SOURCE_TYPE_LABEL, value);
}

/**
 * The ref an answer cites as `type:id` or `type:id|label` (the text between `[[` and `]]`), or
 * null when the type is unknown, the id has characters an inline id may not or a date is not a
 * real day. Inline ids are deliberately narrow: letters, digits, `.`, `_` and `-`.
 */
export function parseRef(text: string): SourceRef | null {
	const match = REF.exec(text);
	if (!match) return null;
	const [, type = '', id = '', rawLabel] = match;
	if (!isSourceType(type)) return null;
	if (type === 'date' && !parseIsoDate(id)) return null;
	const label = rawLabel?.trim();
	return label ? { type, id, label } : { type, id };
}

/** Profile sections that hold what a ref names (src/lib/ui/profile/sections.ts). */
const PROFILE_SECTION: Partial<Record<SourceType, string>> = {
	goal: 'goals',
	baseline: 'strength',
	preference: 'exercises'
};

/** One encoded path segment, or null for an empty, dot or malformed id. */
function segment(id: string | undefined): string | null {
	if (!id || id.length > 200 || id === '.' || id === '..') return null;
	try {
		return encodeURIComponent(id);
	} catch {
		return null; // a lone surrogate
	}
}

const link = (href: string): SourceAction => ({ kind: 'link', href });

/** What a review's page is keyed by: a weekly review's Monday, or a cycle review's id. */
export type ReviewKeyOf = { kind: 'weekly'; weekStartsOn: string } | { kind: 'cycle'; id: string };

/**
 * A review's page key, which is also its ref's id: `w-<Monday>` for a weekly review, so its link
 * survives a refresh (a new revision has a new id), and `c-<id>` for a cycle review.
 */
export const reviewKey = (review: ReviewKeyOf): string =>
	review.kind === 'weekly' ? `w-${review.weekStartsOn}` : `c-${review.id}`;

const REVIEW_KEY =
	/^(?:w-(\d{4}-\d{2}-\d{2})|c-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Whether `id` is a review page key: a real Monday after `w-`, or a UUID after `c-`. */
function isReviewKey(id: string): boolean {
	const match = REVIEW_KEY.exec(id);
	if (match === null) return false;
	const day = match[1];
	return day === undefined || (parseIsoDate(day) !== null && mondayOf(day) === day);
}

/**
 * Where a source goes: History for logged records, Train for the plan and its versions, Profile
 * for goals, baselines and preferences, the inbox for a proposal, the review's page for a review
 * (by its key, and nothing else), and M4's exercise-history sheet for an exercise. Decisions,
 * notes and dates have no screen of their own (null).
 */
export function sourceAction(ref: SourceRef): SourceAction | null {
	const id = segment(ref.id);
	if (id === null) return null;
	switch (ref.type) {
		case 'workout':
			return link(`/progress/workouts/${id}`);
		case 'set':
		case 'run':
		case 'pain_report': {
			const workout = segment(ref.workoutId);
			return workout === null ? null : link(`/progress/workouts/${workout}`);
		}
		case 'session':
			return link(`/train/session/${id}`);
		case 'version':
			return /^[1-9]\d{0,8}$/.test(ref.id) ? link(`/train/history/${ref.id}`) : null;
		case 'goal':
		case 'baseline':
		case 'preference':
			return link(`/profile/${PROFILE_SECTION[ref.type]}`);
		case 'proposal':
			return link(`/coach/proposals/${id}`);
		case 'review':
			return isReviewKey(ref.id) ? link(`/progress/reviews/${ref.id}`) : null;
		case 'exercise':
			return { kind: 'exercise_history', exerciseId: ref.id };
		default:
			return null;
	}
}
