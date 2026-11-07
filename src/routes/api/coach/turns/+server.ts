import { json } from '@sveltejs/kit';
import type { Config } from '@sveltejs/adapter-vercel';
import * as z from 'zod/mini';
import { COACH_MAX_DURATION_S, TURN_LIMITS } from '#lib/domain/coach/budgets.ts';
import { isSourceType, REF_ID_MAX, REF_LABEL_MAX } from '#lib/domain/coach/sources.ts';
import { coachEventStream, runCoachTurn } from '#lib/server/agent/coach.ts';
import type { TurnEntry } from '#lib/server/agent/tools/context.ts';
import { authErrorResponse, authRequest } from '#lib/server/auth/index.ts';
import { enforceRateLimit } from '#lib/server/auth/rate-limit.ts';
import type { RequestHandler } from './$types';

/** Vercel lets a turn run this long (Fluid compute); every turn limit derives from it. */
export const config: Config = { maxDuration: COACH_MAX_DURATION_S };

const MAX_BODY_BYTES = 64 * 1024;
const NO_STORE = { 'cache-control': 'no-store' };

const ref = z.strictObject({
	type: z.string().check(z.refine(isSourceType)),
	id: z.string().check(z.minLength(1), z.maxLength(REF_ID_MAX)),
	label: z.optional(z.string().check(z.maxLength(REF_LABEL_MAX))),
	date: z.optional(z.string().check(z.regex(/^\d{4}-\d{2}-\d{2}$/))),
	workoutId: z.optional(z.uuid())
});

/** What the composer sends; the text's own rules (length, blank) are the threads service's. */
const TurnBody = z.strictObject({
	threadId: z.optional(z.nullable(z.uuid())),
	clientMessageId: z.uuid(),
	text: z.string(),
	entry: z.optional(
		z.nullable(
			z.strictObject({
				from: z.string().check(z.regex(/^[a-z][a-z_]{0,31}$/)),
				ref: z.nullable(ref)
			})
		)
	)
});

const invalid = (message: string) =>
	json({ error: 'invalid_request', message }, { status: 400, headers: NO_STORE });

/**
 * One coach turn, streamed as server-sent events (domain/coach/events.ts). Owner-only and
 * Origin-checked by the guard; rate-limited ('coach.turn', 429 with Retry-After); 400 for a body
 * that is not a turn. Everything after that is in the stream, which always ends with `done`: a
 * coach that is not launched or switched off answers one error event and writes nothing, the
 * daily cap answers a budget error. The turn stops when the client leaves (request.signal) or
 * the stream is cancelled; Stop also flags the run (POST /api/coach/runs/[run]/cancel).
 */
export const POST: RequestHandler = async (event) => {
	const { request, locals } = event;
	const deadlineAt = Date.now() + TURN_LIMITS.turnMs;
	try {
		await enforceRateLimit('coach.turn', 'global', authRequest(event));
	} catch (err) {
		return authErrorResponse(err);
	}

	const length = Number(request.headers.get('content-length') ?? 0);
	const text = length > MAX_BODY_BYTES ? '' : await request.text();
	if (length > MAX_BODY_BYTES || text.length > MAX_BODY_BYTES) return invalid('At most 64 KB');
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return invalid('Body must be JSON');
	}
	const body = TurnBody.safeParse(raw);
	if (!body.success) return invalid('Body is not a coach turn');

	const stop = new AbortController();
	const leave = () => stop.abort(request.signal.reason);
	if (request.signal.aborted) leave();
	else request.signal.addEventListener('abort', leave, { once: true });

	const turn = runCoachTurn(
		{
			// The guard answers 401 without a session and 403 for a recovery one: this is the owner's.
			ownerId: locals.session!.ownerId,
			threadId: body.data.threadId ?? null,
			clientMessageId: body.data.clientMessageId,
			text: body.data.text,
			entry: (body.data.entry ?? null) as TurnEntry | null,
			signal: stop.signal
		},
		{ deadlineAt }
	);
	const stream = coachEventStream(turn, { onCancel: () => stop.abort() });
	return new Response(stream, {
		headers: {
			...NO_STORE,
			'content-type': 'text/event-stream; charset=utf-8',
			'x-accel-buffering': 'no'
		}
	});
};
