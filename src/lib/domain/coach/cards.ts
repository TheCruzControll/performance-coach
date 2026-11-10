/**
 * A coach proposal as its card in the conversation shows it (M5 plan, coach-proposal-cards): what
 * changes (its rows), why (the rationale), the impact on each week it touches, and where it
 * stands. Client-safe and zod-free, imported by path: the Coach screen's server maps each stored
 * proposal view to a card, and the browser maps the view an Accept answers with.
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
}

/** The card's fields of a view, and nothing else (no links, notes or dates go to the page). */
export function cardOf(view: ProposalCardSource): ProposalCardView {
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
		supersededReason: view.supersededReason
	};
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null;
const isStrings = (value: unknown): value is string[] =>
	Array.isArray(value) && value.every((each) => typeof each === 'string');

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
		(reason === null || Object.hasOwn(SUPERSEDED_REASON_LABEL, reason as string));
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

/** Where a card stands, in words: the state the owner sees under its rows. */
export type CardState =
	| { kind: 'proposed' }
	| { kind: 'applied'; words: string; version: number | null }
	| { kind: 'waiting'; words: string }
	| { kind: 'superseded'; words: string }
	| { kind: 'rejected'; words: string };

export function cardState(card: ProposalCardView): CardState {
	switch (card.status) {
		case 'proposed':
			return { kind: 'proposed' };
		case 'applied':
			return card.appliedVersion === null
				? { kind: 'applied', words: 'Applied', version: null }
				: {
						kind: 'applied',
						words: `Applied as version ${card.appliedVersion}`,
						version: card.appliedVersion
					};
		case 'accepted':
			return { kind: 'waiting', words: card.kind === 'next_cycle' ? NEXT_CYCLE_WAITS : 'Accepted' };
		case 'superseded':
			return {
				kind: 'superseded',
				words: card.supersededReason
					? SUPERSEDED_REASON_LABEL[card.supersededReason]
					: 'Replaced since it was proposed'
			};
		case 'rejected':
			return { kind: 'rejected', words: 'Declined' };
	}
}
