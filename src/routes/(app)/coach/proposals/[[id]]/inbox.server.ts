/**
 * What the Proposals inbox (/coach/proposals/[[id]]) renders, in words composed on the server so
 * they cost the screen no JavaScript:
 * - The list: the proposals waiting for the owner first, then every decided one, each newest
 *   first, INBOX_PAGE at a time. `?show=` narrows it to one of the two; `?more=<cursor>` is the
 *   page after the one that gave the cursor, which 'Show more' reads without navigating
 *   (preloadData). A cursor names its list and the last proposal shown (`w.<id>` or `d.<id>`);
 *   a malformed one is the first page.
 * - /coach/proposals/<id>: that proposal as its card shows it, with when it was proposed and
 *   decided, the owner's reason for a rejection, and the conversation it came from.
 * - A malformed or unknown id, or someone else's proposal, is the 404 page in the shell. The route
 *   has no param matcher, which would cost every route JavaScript (docs/performance.md).
 * - It fails soft: a read that fails is recorded as a server error (kind 'load') and the screen
 *   shows its load-failed state with Retry, inside the shell, instead of the 500 page.
 * Kept out of +page.server.ts so integration tests can run it with an unreachable database.
 */
import { error, isHttpError } from '@sveltejs/kit';
import { cardOf, cardState, type ProposalCardView } from '#lib/domain/coach/cards.ts';
import { localDay } from '#lib/domain/dates.ts';
import type { ProposalStatus } from '#lib/domain/training/vocabulary.ts';
import { recordServerError, type ServerErrorInput } from '#lib/server/services/errors.ts';
import { isUuid } from '#lib/server/services/ids.ts';
import { getAthleteProfile } from '#lib/server/services/profile/index.ts';
import {
	getProposalView,
	listProposals,
	PROPOSAL_PAGE,
	REVIEW_SOURCE_LABEL,
	type ProposalQuery,
	type ProposalView
} from '#lib/server/services/coach/proposals.ts';
import { CoachNotFoundError, type CoachDeps } from '#lib/server/services/coach/shared.ts';
import { shortDate } from '#lib/ui/program/words.ts';

/** Proposals per page of the inbox (M5 plan: pages of 20). */
export const INBOX_PAGE = PROPOSAL_PAGE.default;

/** The inbox's two lists, in the order 'All' shows them. */
type List = 'waiting' | 'decided';
const LISTS: Record<List, { code: string; query: ProposalQuery }> = {
	waiting: { code: 'w', query: { status: 'proposed' } },
	decided: { code: 'd', query: { decided: true } }
};

/** What `?show=` may narrow the inbox to; anything else is 'all'. */
export const INBOX_FILTERS = ['all', 'waiting', 'decided'] as const;
export type InboxFilter = (typeof INBOX_FILTERS)[number];
const SHOWN: Record<InboxFilter, List[]> = {
	all: ['waiting', 'decided'],
	waiting: ['waiting'],
	decided: ['decided']
};

/** What each kind of proposal is called in the inbox. */
export const PROPOSAL_KIND_WORDS: Record<string, string> = {
	program_adjustment: 'Program change',
	workout_update: 'Workout change',
	session_substitution: 'Exercise swap',
	new_program: 'New program',
	next_cycle: 'Next cycle',
	goal_update: 'Goal change',
	preference_update: 'Exercise preference'
};
const kindWords = (kind: string) => PROPOSAL_KIND_WORDS[kind] ?? 'Change';

/** One proposal in the list: one link, everything it says in words. */
export interface InboxRow {
	id: string;
	title: string;
	status: ProposalStatus;
	/** Where it stands: 'Waiting for you', 'Applied as version 4', 'Declined'. */
	state: string;
	/** Its kind and the day it was proposed: 'Program change · Mon 9 Nov'. */
	meta: string;
}

/** The proposal the inbox opened, beside the list on a desktop window. */
export interface InboxDetail {
	card: ProposalCardView;
	kind: string;
	/** 'Proposed Mon 9 Nov' and, once decided, 'Decided Tue 10 Nov'. */
	dates: string[];
	/** The owner's reason for a rejection; their own words, shown as text. */
	note: string | null;
	/** The conversation it came from; null for a review's. */
	threadId: string | null;
	/** 'From your weekly review' for a proposal the rules made for a review. */
	from: string | null;
}

export type InboxData =
	| {
			state: 'ready';
			filter: InboxFilter;
			rows: InboxRow[];
			/** The `more` that gives the next page; null on the last. */
			next: string | null;
			detail: InboxDetail | null;
			/** The owner has no proposal at all (not just none in this filter). */
			none: boolean;
	  }
	| { state: 'failed'; filter: InboxFilter };

export interface InboxRequest {
	/** The route's optional [[id]], as given. */
	id: string | undefined;
	search: URLSearchParams;
	origin: Pick<ServerErrorInput, 'requestId' | 'method' | 'path' | 'routeId' | 'appVersion'>;
}

export interface InboxDeps extends CoachDeps {
	/** Where a failure is recorded (app_errors): the app's database unless given. */
	errorsDb?: CoachDeps['db'];
}

const filterOf = (show: string | null): InboxFilter =>
	INBOX_FILTERS.includes(show as InboxFilter) ? (show as InboxFilter) : 'all';

/** Where a page starts: the list a cursor names (if the filter shows it) and after which id. */
function startOf(more: string | null, lists: List[]): { at: number; before?: string } {
	const [code, id] = (more ?? '').split('.');
	const at = lists.findIndex((list) => LISTS[list].code === code);
	if (at < 0 || (id !== '' && !isUuid(id ?? ''))) return { at: 0 };
	return { at, before: id || undefined };
}

/**
 * One page of the inbox: what is left of the first list the page starts in, then the next list
 * from its start, until INBOX_PAGE proposals. Each list is read on its own, one after the other.
 */
async function pageOf(
	ownerId: string,
	filter: InboxFilter,
	more: string | null,
	deps: CoachDeps
): Promise<{ proposals: ProposalView[]; next: string | null }> {
	const lists = SHOWN[filter];
	let { at, before } = startOf(more, lists);
	const proposals: ProposalView[] = [];
	for (; at < lists.length; at++, before = undefined) {
		const { code, query } = LISTS[lists[at]!];
		const page = await listProposals(
			ownerId,
			{ ...query, before, limit: INBOX_PAGE - proposals.length },
			deps
		);
		proposals.push(...page.proposals);
		if (page.next) return { proposals, next: `${code}.${page.next}` };
		const following = lists[at + 1];
		if (proposals.length === INBOX_PAGE) {
			return { proposals, next: following ? `${LISTS[following].code}.` : null };
		}
	}
	return { proposals, next: null };
}

const stateWords = (card: ProposalCardView) => {
	const state = cardState(card);
	return state.kind === 'proposed' ? 'Waiting for you' : state.words;
};

const dayWords = (at: Date, timeZone: string) => shortDate(localDay(at, timeZone));

function detailOf(view: ProposalView, timeZone: string): InboxDetail {
	const dates = [`Proposed ${dayWords(view.createdAt, timeZone)}`];
	if (view.closedAt) dates.push(`Decided ${dayWords(view.closedAt, timeZone)}`);
	return {
		card: cardOf(view),
		kind: kindWords(view.kind),
		dates,
		note: view.decisionNote,
		threadId: view.threadId,
		from: view.origin ? `From your ${REVIEW_SOURCE_LABEL[view.origin.kind].toLowerCase()}` : null
	};
}

export async function loadInbox(
	ownerId: string,
	{ id, search, origin }: InboxRequest,
	{ errorsDb, ...deps }: InboxDeps = {}
): Promise<InboxData> {
	if (id !== undefined && !isUuid(id)) error(404, 'Not found');
	const filter = filterOf(search.get('show'));
	try {
		const more = search.get('more');
		const view = id === undefined ? null : await getProposalView(ownerId, id, deps);
		const { proposals, next } = await pageOf(ownerId, filter, more, deps);
		const { timeZone } = await getAthleteProfile(ownerId, { db: deps.db });
		// A first page with nothing in it: none at all, or none of the kind the filter shows?
		const none =
			more === null &&
			proposals.length === 0 &&
			(filter === 'all' ||
				(await listProposals(ownerId, { limit: 1 }, deps)).proposals.length === 0);
		return {
			state: 'ready',
			filter,
			rows: proposals.map((each) => {
				const card = cardOf(each);
				return {
					id: each.id,
					title: each.title,
					status: each.status,
					state: stateWords(card),
					meta: `${kindWords(each.kind)} · ${dayWords(each.createdAt, timeZone)}`
				};
			}),
			next,
			detail: view && detailOf(view, timeZone),
			none
		};
	} catch (err) {
		if (isHttpError(err)) throw err;
		if (err instanceof CoachNotFoundError) error(404, 'Not found');
		await recordServerError(
			{ error: err, kind: 'load', status: 500, ...origin, context: { load: 'proposals' } },
			{ db: errorsDb }
		);
		return { state: 'failed', filter };
	}
}
