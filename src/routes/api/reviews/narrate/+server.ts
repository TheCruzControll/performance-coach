import { json } from '@sveltejs/kit';
import type { Config } from '@sveltejs/adapter-vercel';
import { COACH_MAX_DURATION_S } from '#lib/domain/coach/budgets.ts';
import {
	narrateReview,
	narrationBlocks,
	narrationState,
	type NarrationOutcome,
	type NarrationState,
	type ReviewTarget
} from '#lib/server/agent/reviews/narrate.ts';
import { isUuid } from '#lib/server/services/ids.ts';
import { ReviewNotFoundError, ReviewSupersededError } from '#lib/server/services/reviews/store.ts';
import type { RequestHandler } from './$types';

/** A write-up is one coach turn: it may run as long as /api/coach/turns (Fluid compute). */
export const config: Config = { maxDuration: COACH_MAX_DURATION_S };

const MAX_BODY_BYTES = 1024;
const NO_STORE = { 'cache-control': 'no-store' };

const reply = (body: unknown, status = 200) => json(body, { status, headers: NO_STORE });

function targetOf(kind: unknown, id: unknown): ReviewTarget | null {
	return (kind === 'weekly' || kind === 'cycle') && typeof id === 'string' && isUuid(id)
		? { kind, id }
		: null;
}

/** The answer, with the run's display blocks once written; a missing review is a 404. */
async function answer(ownerId: string, read: () => Promise<NarrationOutcome | NarrationState>) {
	try {
		const body = await read();
		if (!('narrative' in body)) return reply(body);
		return reply({ ...body, blocks: await narrationBlocks(ownerId, body) });
	} catch (err) {
		if (err instanceof ReviewNotFoundError) return reply({ error: 'not_found' }, 404);
		if (err instanceof ReviewSupersededError) return reply({ outcome: 'superseded' }, 409);
		throw err;
	}
}

/**
 * Write review {kind, id} up (agent/reviews/narrate.ts): owner-only and Origin-checked by the
 * guard; JSON {outcome, runId?, …}, the blocks included once written. The run is never given
 * request.signal: a client that leaves does not cancel it, and the next visit shows the stored
 * result. 400 for a body that is not a review, 404 for a review that is not the owner's, 409 for
 * one a refresh superseded.
 */
export const POST: RequestHandler = async ({ locals, request }) => {
	const length = Number(request.headers.get('content-length') ?? 0);
	const text = length > MAX_BODY_BYTES ? '' : await request.text();
	let body: { kind?: unknown; id?: unknown } | null;
	try {
		body = text.length > MAX_BODY_BYTES ? null : JSON.parse(text);
	} catch {
		body = null;
	}
	const target = targetOf(body?.kind, body?.id);
	if (!target) return reply({ error: 'invalid_request', message: 'Body is not a review' }, 400);
	// The guard answers 401 without a session and 403 for a recovery one: this is the owner's.
	const ownerId = locals.session!.ownerId;
	return answer(ownerId, () => narrateReview(ownerId, target));
};

/** ?kind&id: the stored write-up, the run writing it, or neither (narrationState), for polling. */
export const GET: RequestHandler = async ({ locals, url }) => {
	const target = targetOf(url.searchParams.get('kind'), url.searchParams.get('id'));
	if (!target) return reply({ error: 'invalid_request', message: 'Not a review' }, 400);
	const ownerId = locals.session!.ownerId;
	return answer(ownerId, () => narrationState(ownerId, target));
};
