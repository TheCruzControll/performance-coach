/**
 * A coach proposal as its card in the conversation shows it (M5 plan, coach-proposal-cards): what
 * changes (its rows), why (the rationale), the impact on each week it touches, and where it
 * stands. Client-safe and zod-free, imported by path: the Coach screen's server maps each stored
 * proposal view to a card, and the browser maps the view an Accept answers with.
 *
 * A proposal the rules made for one of M6's reviews says so ('From your weekly review · Week of
 * 2 Nov', linking to it), and every way M6 closes a proposal leads back to its review: a
 * superseded label with its link, 'Waits for your cycle review' linking to it, and the review's
 * own next cycle, whose start is chosen in the review, offered there instead of Accept.
 */
import type { IsoDate } from '../calendar.ts';
import { PROPOSAL_STATUSES, type ProposalStatus } from '../training/vocabulary.ts';
import { SUPERSEDED_REASON_LABEL, type SupersededReason } from './vocabulary.ts';

/** One row of a card: what changes, from what to what, on which day. */
export interface ProposalCardRow {
	label: string;
	before: string | null;
	after: string | null;
	date: IsoDate | null;
}

export interface ProposalCardView {
	id: string;
	kind: string;
	status: ProposalStatus;
	title: string;
	rationale: string;
	rows: ProposalCardRow[];
	/** Each changed week in words ('Week of Mon 9 Nov: Quads −3 hard sets, −12 min'). */
	impactLines: string[];
	/** The interference rules its changes newly break, in words. */
	warnings: string[];
	/** The program version accepting it made. */
	appliedVersion: number | null;
	supersededReason: SupersededReason | null;
	/** The review whose rules proposed it: 'From your weekly review · Week of 2 Nov' and its page. */
	origin?: { words: string; href: string };
	/** The review its state leads to: where it waits, was folded in or is finished. */
	reviewHref?: string;
	/** The review's own next cycle: its start is chosen at reviewHref, so it has no Accept. */
	chooseStart?: true;
}

/** Where a review's proposal came from (services/coach/proposals.ts ProposalOrigin). */
export interface CardOrigin {
	kind: 'weekly_review' | 'cycle_review' | 'goal_priority' | 'fatigue';
	href: string;
	/** A weekly review's Monday. */
	weekStartsOn?: IsoDate | null;
}

/** What a card reads from a proposal view (services/coach/proposals.ts ProposalView, or its JSON). */
export interface ProposalCardSource {
	id: string;
	kind: string;
	status: ProposalStatus;
	title: string;
	rationale: string;
	rows: readonly ProposalCardRow[];
	impactLines: readonly string[];
	warnings: readonly string[];
	appliedVersion: { number: number } | null;
	supersededReason: SupersededReason | null;
	origin?: CardOrigin | null;
	/** The cycle review a coach next cycle waits for, or was folded into or planned by. */
	cycleReview?: { href: string } | null;
	/** Set on the review's own open next cycle: the review that chooses its start. */
	chooseStart?: { href: string } | null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Where an M7 re-plan the rules made came from, in words. */
const ENGINE_WORDS = {
	goal_priority: 'From your goal change',
	fatigue: 'From your training load'
} as const;

/** 'From your weekly review · Week of 2 Nov', 'From your cycle review', or an engine's words. */
function originWords({ kind, weekStartsOn }: CardOrigin): string {
	if (kind === 'goal_priority' || kind === 'fatigue') return ENGINE_WORDS[kind];
	if (kind === 'cycle_review') return 'From your cycle review';
	if (!weekStartsOn) return 'From your weekly review';
	const day = `${Number(weekStartsOn.slice(8))} ${MONTHS[Number(weekStartsOn.slice(5, 7)) - 1]}`;
	return `From your weekly review · Week of ${day}`;
}

/** The card's fields of a view, and nothing else (no links, notes or dates go to the page). */
export function cardOf(view: ProposalCardSource): ProposalCardView {
	const reviewHref = view.chooseStart?.href ?? view.cycleReview?.href ?? view.origin?.href;
	return {
		id: view.id,
		kind: view.kind,
		status: view.status,
		title: view.title,
		rationale: view.rationale,
		rows: view.rows.map(({ label, before, after, date }) => ({ label, before, after, date })),
		impactLines: [...view.impactLines],
		warnings: [...view.warnings],
		appliedVersion: view.appliedVersion?.number ?? null,
		supersededReason: view.supersededReason,
		...(view.origin && { origin: { words: originWords(view.origin), href: view.origin.href } }),
		...(reviewHref && { reviewHref }),
		...(view.chooseStart && { chooseStart: true })
	};
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null;
const isStrings = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((each) => typeof each === 'string');
/** Absent, null, or an object with an in-app path as its href (never another origin's link). */
const isLink = (value: unknown) =>
	value === undefined ||
	value === null ||
	(isObject(value) &&
		typeof value.href === 'string' &&
		value.href.startsWith('/') &&
		!value.href.startsWith('//'));

/** A card from a proposal view's JSON (an Accept's answer); null for anything else. */
export function parseCard(value: unknown): ProposalCardView | null {
	if (!isObject(value)) return null;
	const { id, kind, status, title, rationale, rows, impactLines, warnings, appliedVersion } = value;
	const reason = value.supersededReason;
	const fine =
		typeof id === 'string' &&
		typeof kind === 'string' &&
		typeof title === 'string' &&
		typeof rationale === 'string' &&
		PROPOSAL_STATUSES.includes(status as ProposalStatus) &&
		Array.isArray(rows) &&
		rows.every((row) => isObject(row) && typeof row.label === 'string') &&
		isStrings(impactLines) &&
		isStrings(warnings) &&
		(appliedVersion === null ||
			(isObject(appliedVersion) && Number.isInteger(appliedVersion.number))) &&
		(reason === null || Object.hasOwn(SUPERSEDED_REASON_LABEL, reason as string)) &&
		isLink(value.origin) &&
		isLink(value.cycleReview) &&
		isLink(value.chooseStart) &&
		(!isObject(value.origin) ||
			['weekly_review', 'cycle_review', 'goal_priority', 'fatigue'].includes(
				value.origin.kind as string
			));
	return fine ? cardOf(value as unknown as ProposalCardSource) : null;
}

/**
 * The longest reason a rejection keeps, in characters: coach_proposals.decision_note's bound
 * (DECISION_NOTE_MAX, which a unit test holds this to).
 */
export const REJECT_REASON_MAX = 500;
/** The longest change 'Ask for changes' sends the coach, in characters. */
export const CHANGE_REQUEST_MAX = 500;
/**
 * The entry an 'Ask for changes' turn names, with the proposal as its ref: the coach drafts a
 * revision of it, which supersedes it ('revised').
 */
export const ASK_FOR_CHANGES = 'ask_for_changes';

/**
 * Decision (M5 plan, 'next_cycle: accepted now, and applied by M6'): an accepted next cycle waits
 * for the cycle review that plans it, and its card says so.
 */
export const NEXT_CYCLE_WAITS = 'Waits for your cycle review';

/**
 * Decision (M6 plan, 'From M5's inbox'): the review's own next cycle needs a start chosen in the
 * review, so its card leads there instead of offering Accept. The server's 409 choose_start says
 * the same (apply/next-cycle.ts CHOOSE_START).
 */
export const CHOOSE_START = 'Choose when it starts in your cycle review';

/** The link beside a superseded label that opens the review ('… · open'). */
export const OPEN_REVIEW = 'open';

/**
 * What the link beside M6's superseded labels says: each leads to the review that took the
 * proposal over ('Replaced by a refreshed review · open').
 */
export const SUPERSEDED_LINK_WORDS: Partial<Record<SupersededReason, string>> = {
	review_refreshed: OPEN_REVIEW,
	folded_into_review: OPEN_REVIEW,
	sessions_passed: 'Finish in your weekly review',
	cycle_planned: OPEN_REVIEW
};

/** A link a card's state leads to, in words. */
export interface CardLink {
	words: string;
	href: string;
}

/** Where a card stands, in words: the state the owner sees under its rows. */
export type CardState =
	| { kind: 'proposed' }
	/** The review's own next cycle: no Accept, its start is chosen at href. */
	| { kind: 'choose'; words: string; href: string }
	| { kind: 'applied'; words: string; version: number | null }
	| { kind: 'waiting'; words: string; href?: string }
	| { kind: 'superseded'; words: string; link?: CardLink }
	| { kind: 'rejected'; words: string };

export function cardState(card: ProposalCardView): CardState {
	switch (card.status) {
		case 'proposed':
			return card.chooseStart && card.reviewHref
				? { kind: 'choose', words: CHOOSE_START, href: card.reviewHref }
				: { kind: 'proposed' };
		case 'applied':
			return card.appliedVersion === null
				? { kind: 'applied', words: 'Applied', version: null }
				: {
						kind: 'applied',
						words: `Applied as version ${card.appliedVersion}`,
						version: card.appliedVersion
					};
		case 'accepted':
			if (card.kind !== 'next_cycle') return { kind: 'waiting', words: 'Accepted' };
			return {
				kind: 'waiting',
				words: NEXT_CYCLE_WAITS,
				...(card.reviewHref && { href: card.reviewHref })
			};
		case 'superseded': {
			const reason = card.supersededReason;
			const link = reason && SUPERSEDED_LINK_WORDS[reason];
			return {
				kind: 'superseded',
				words: reason ? SUPERSEDED_REASON_LABEL[reason] : 'Replaced since it was proposed',
				...(link && card.reviewHref && { link: { words: link, href: card.reviewHref } })
			};
		}
		case 'rejected':
			return { kind: 'rejected', words: 'Declined' };
	}
}
