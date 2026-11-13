/**
 * What the Coach screens (/coach/[[thread]]) render, in words composed on the server (words.ts):
 * - /coach: the owner's open conversations, newest first, a page at a time (listThreads), and the
 *   question an entry point prefilled (?ask=…&from=…). `?before=<id>` is the page after that
 *   conversation, the cursor a page gives: 'Show older' reads it without navigating
 *   (preloadData). A malformed cursor is the first page.
 * - /coach/<id>: that conversation's newest shown messages (getThreadView), each proposal its
 *   runs made as a card after the run's answer (listThreadProposals), as it stands now, and
 *   whether it is archived (read-only until unarchived).
 * - A malformed or unknown id, or someone else's conversation, is the 404 page in the shell. The
 *   route has no param matcher, which would cost every route JavaScript (docs/performance.md).
 * - An entry about a review (a review's 'Discuss with your coach': from weekly_review or
 *   cycle_review, ref review:<key>) is kept only when the review is the owner's; otherwise the
 *   question stays and the entry is dropped.
 * - It fails soft: a read that fails is recorded as a server error (kind 'load') and the screen
 *   shows the load-failed notice with Retry, inside the shell, instead of the 500 page.
 * Kept out of +page.server.ts so integration tests can run it with an unreachable database.
 */
import { error, isHttpError } from '@sveltejs/kit';
import { cardOf } from '#lib/domain/coach/cards.ts';
import { recordServerError, type ServerErrorInput } from '#lib/server/services/errors.ts';
import { isUuid } from '#lib/server/services/ids.ts';
import { getAthleteProfile } from '#lib/server/services/profile/index.ts';
import { hasReview } from '#lib/server/services/reviews/store.ts';
import { listThreadProposals } from '#lib/server/services/coach/proposals.ts';
import { CoachNotFoundError, type CoachDeps } from '#lib/server/services/coach/shared.ts';
import { getThreadView, listThreads } from '#lib/server/services/coach/threads.ts';
import {
	prefillOf,
	shownMessages,
	whenWords,
	type Prefill,
	type ShownMessage,
	type ThreadRowView
} from './words';

/** One conversation, opened. */
export interface ThreadView {
	id: string;
	title: string;
	/** Archived: read-only, until Unarchive returns it to Recent. */
	archived: boolean;
	messages: ShownMessage[];
}

export type CoachScreenData = { prefill: Prefill | null } & (
	| {
			failed: false;
			/** Recent conversations on /coach (empty on a conversation). */
			threads: ThreadRowView[];
			/** The `before` that gives the next page; null on the last. */
			next: string | null;
			/** The conversation /coach/<id> opened; null on /coach. */
			thread: ThreadView | null;
	  }
	| { failed: true }
);

export interface CoachScreenRequest {
	/** The route's optional [[thread]], as given. */
	thread: string | undefined;
	/** The URL's query: the ?before cursor and the prefill. */
	search: URLSearchParams;
	origin: Pick<ServerErrorInput, 'requestId' | 'method' | 'path' | 'routeId' | 'appVersion'>;
}

export interface CoachScreenDeps extends CoachDeps {
	/** Where a failure is recorded (app_errors): the app's database unless given. */
	errorsDb?: CoachDeps['db'];
}

export async function loadCoachScreen(
	ownerId: string,
	{ thread, search, origin }: CoachScreenRequest,
	{ db, now = () => new Date(), errorsDb }: CoachScreenDeps = {}
): Promise<CoachScreenData> {
	if (thread !== undefined && !isUuid(thread)) error(404, 'Not found');
	const asked = thread === undefined ? prefillOf(search) : null;
	// A review's entry is left out until its ref is found to be one of the owner's reviews.
	const review =
		asked?.ref?.type === 'review' ||
		asked?.from === 'weekly_review' ||
		asked?.from === 'cycle_review';
	let prefill = review ? { ...asked!, from: null, label: null, ref: null } : asked;
	try {
		const ref = review && asked!.ref?.type === 'review' ? asked!.ref.id : null;
		if (ref !== null && (await hasReview(ownerId, ref, { db }))) prefill = asked;
		if (thread !== undefined) {
			const view = await getThreadView(ownerId, thread, {}, { db });
			const runIds = view.messages.flatMap((row) => (row.runId ? [row.runId] : []));
			const proposals = await listThreadProposals(ownerId, view.thread.id, runIds, { db });
			const cards = proposals.map(({ runId, proposal }) => ({ runId, card: cardOf(proposal) }));
			return {
				prefill,
				failed: false,
				threads: [],
				next: null,
				thread: {
					id: view.thread.id,
					title: view.thread.title,
					archived: view.thread.archived,
					messages: shownMessages(view.messages, cards)
				}
			};
		}
		const before = search.get('before');
		const page = await listThreads(
			ownerId,
			{ before: before !== null && isUuid(before) ? before : undefined },
			{ db }
		);
		const { timeZone } = await getAthleteProfile(ownerId, { db });
		const at = now();
		return {
			prefill,
			failed: false,
			threads: page.threads.map((each) => ({
				id: each.id,
				title: each.title,
				when: whenWords(each.lastMessageAt, at, timeZone)
			})),
			next: page.nextBefore,
			thread: null
		};
	} catch (err) {
		if (isHttpError(err)) throw err;
		if (err instanceof CoachNotFoundError) error(404, 'Not found');
		await recordServerError(
			{ error: err, kind: 'load', status: 500, ...origin, context: { load: 'coach' } },
			{ db: errorsDb }
		);
		return { prefill, failed: true };
	}
}
