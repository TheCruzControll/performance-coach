import { json } from '@sveltejs/kit';
import * as z from 'zod/mini';
import { authErrorResponse, authRequest } from '#lib/server/auth/index.ts';
import { enforceRateLimit } from '#lib/server/auth/rate-limit.ts';
import { NextCycleConflictError } from '#lib/server/services/coach/apply/next-cycle.ts';
import {
	acceptProposal,
	getProposalView,
	ProposalClosedError,
	ProposalRefusedError,
	rejectProposal,
	type ProposalView
} from '#lib/server/services/coach/proposals.ts';
import { CoachInputError, CoachNotFoundError } from '#lib/server/services/coach/shared.ts';
import type { RequestHandler } from './$types';

/** A decision is an action and a short reason (DECISION_NOTE_MAX); anything longer is not one. */
const MAX_BODY_BYTES = 16 * 1024;
const NO_STORE = { 'cache-control': 'no-store' };

/**
 * The only fields read: anything else the client sends (a payload, an ownerId, a status) is
 * dropped by the parse, so what is applied is always the stored proposal, for the session's owner.
 */
const DecisionBody = z.object({
	action: z.enum(['accept', 'reject']),
	reason: z.optional(z.nullable(z.string()))
});

/** The statuses an accept leaves a proposal in when it went through. */
const ACCEPTED: ReadonlySet<ProposalView['status']> = new Set(['accepted', 'applied']);

const invalid = (message: string, field?: string) =>
	json({ error: 'invalid_request', message, field }, { status: 400, headers: NO_STORE });
const conflict = (proposal: ProposalView, href?: string) =>
	json({ error: 'conflict', proposal, ...(href && { href }) }, { status: 409, headers: NO_STORE });

/**
 * Accept or reject one of the owner's proposals by id (PRD §14; the M5 plan's 'Proposals versus
 * committed changes'). Only the path id, the action and the reason are read; the owner is the
 * session's. Accept re-parses and re-checks the stored payload against today and applies it.
 *
 * - 200 {proposal, changed}: accepted, applied or rejected. Repeating it answers the stored
 *   result with changed: false, and writes nothing.
 * - 409 {error: 'conflict', proposal, href?}: it was superseded (now or before), or already
 *   decided the other way; the proposal says how, and href is the cycle review it was folded into. 409 {error: 'conflict', reason: 'choose_start', href}: a
 *   cycle review's next block, which is planned from the review at href; it stays proposed.
 * - 400: a body that is not a decision, a reason too long, or a proposal that no longer passes
 *   today's rules (error 'refused', with its field errors; it stays proposed).
 * - 404 for an id that is not the owner's proposal. Owner-only and Origin-checked by the guard;
 *   rate-limited ('coach.action').
 */
export const POST: RequestHandler = async (event) => {
	const { request, params, locals } = event;
	try {
		await enforceRateLimit('coach.action', 'global', authRequest(event));
	} catch (err) {
		return authErrorResponse(err);
	}

	const length = Number(request.headers.get('content-length') ?? 0);
	const text = length > MAX_BODY_BYTES ? '' : await request.text();
	if (length > MAX_BODY_BYTES || text.length > MAX_BODY_BYTES) return invalid('At most 16 KB');
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return invalid('Body must be JSON');
	}
	const body = DecisionBody.safeParse(raw);
	if (!body.success) return invalid('Body is not a decision');

	// The guard answers 401 without a session and 403 for a recovery one: this is the owner's.
	const ownerId = locals.session!.ownerId;
	try {
		if (body.data.action === 'accept') {
			const decided = await acceptProposal(ownerId, params.id);
			if (!ACCEPTED.has(decided.proposal.status)) return conflict(decided.proposal, decided.href);
			return json(decided, { headers: NO_STORE });
		}
		const decided = await rejectProposal(ownerId, params.id, { reason: body.data.reason });
		return json(decided, { headers: NO_STORE });
	} catch (err) {
		if (err instanceof CoachNotFoundError) {
			return json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
		}
		if (err instanceof ProposalClosedError) {
			return conflict(await getProposalView(ownerId, params.id));
		}
		if (err instanceof NextCycleConflictError) {
			const { reason, href, message } = err;
			return json({ error: 'conflict', reason, href, message }, { status: 409, headers: NO_STORE });
		}
		if (err instanceof ProposalRefusedError) {
			return json({ error: 'refused', errors: err.errors }, { status: 400, headers: NO_STORE });
		}
		if (err instanceof CoachInputError) return invalid(err.message, err.field);
		throw err;
	}
};
