/**
 * The 'Propose again' action of a stale re-plan's detail (/coach/proposals/<id>?/proposeAgain):
 * the owner's check, the id from the route, then proposeAgain (services/periodisation/propose.ts),
 * whose answer is an outcome the card shows (domain/coach/propose-again.ts). A proposal that is
 * not the owner's, or not there, is the 404 page; any other failure is recorded (app_errors) and
 * answered as failed, so the card offers Try again, which sends the same request again.
 * Kept out of +page.server.ts so integration tests can run it on their own database, as
 * inbox.server.ts is.
 */
import { error, isHttpError } from '@sveltejs/kit';
import type { ProposeAgainOutcome } from '#lib/domain/coach/propose-again.ts';
import { ownerId } from '#lib/server/forms/read.ts';
import { recordServerError } from '#lib/server/services/errors.ts';
import { isUuid } from '#lib/server/services/ids.ts';
import {
	proposeAgain,
	type ProposedAgain,
	type ProposeDeps
} from '#lib/server/services/periodisation/propose.ts';
import { CoachNotFoundError } from '#lib/server/services/coach/shared.ts';

/** The route the action belongs to, as app_errors names it. */
const ROUTE_ID = '/(app)/coach/proposals/[[id]]';

/** The request fields the action reads: the signed-in session, the route's id and the request. */
export interface ProposeAgainEvent {
	locals: App.Locals;
	params: { id?: string };
	request: Request;
}

export interface ProposeAgainActionDeps extends ProposeDeps {
	/** Where a failure is recorded (app_errors): the app's database unless given. */
	errorsDb?: ProposeDeps['db'];
}

/** What the service answered, as the card reads it. */
export function outcomeOf(made: ProposedAgain): ProposeAgainOutcome {
	switch (made.status) {
		case 'proposed':
			return { status: 'proposed', id: made.proposal.id };
		case 'refused':
			return { status: 'refused', why: made.why };
		case 'unchanged':
			return { status: 'unchanged' };
		case 'not_stale':
			return { status: 'not_stale' };
		case 'not_reproposable':
			return { status: 'not_reproposable' };
	}
}

export async function proposeAgainAction(
	event: ProposeAgainEvent,
	deps: ProposeAgainActionDeps = {}
): Promise<ProposeAgainOutcome> {
	const owner = ownerId(event.locals);
	const { id } = event.params;
	if (!isUuid(id)) error(404, 'Not found');
	try {
		return outcomeOf(await proposeAgain(owner, id, deps));
	} catch (err) {
		if (isHttpError(err)) throw err;
		if (err instanceof CoachNotFoundError) error(404, 'Not found');
		await recordServerError(
			{
				error: err,
				kind: 'app',
				status: 500,
				requestId: event.locals.requestId,
				method: event.request.method,
				path: new URL(event.request.url).pathname,
				routeId: ROUTE_ID,
				context: { part: 'propose-again' }
			},
			{ db: deps.errorsDb ?? deps.db }
		);
		return { status: 'failed' };
	}
}
