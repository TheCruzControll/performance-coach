import { json } from '@sveltejs/kit';
import * as z from 'zod/mini';
import { authErrorResponse, authRequest } from '#lib/server/auth/index.ts';
import { enforceRateLimit } from '#lib/server/auth/rate-limit.ts';
import { CoachInputError, CoachNotFoundError } from '#lib/server/services/coach/shared.ts';
import {
	archiveThread,
	renameThread,
	unarchiveThread,
	type CoachThread
} from '#lib/server/services/coach/threads.ts';
import { THREAD_ACTIONS, type ManagedThread } from '../../../../(app)/coach/[[thread]]/manage.ts';
import type { RequestHandler } from './$types';

/** An action and at most a title (THREAD_TITLE_MAX characters); anything longer is not one. */
const MAX_BODY_BYTES = 4 * 1024;
const NO_STORE = { 'cache-control': 'no-store' };

/** The only fields read: anything else the client sends is dropped by the parse. */
const ActionBody = z.object({
	action: z.enum(THREAD_ACTIONS),
	title: z.optional(z.string())
});

const invalid = (message: string, field?: string) =>
	json({ error: 'invalid_request', message, field }, { status: 400, headers: NO_STORE });

const managed = (thread: CoachThread): ManagedThread => ({
	id: thread.id,
	title: thread.title,
	archived: thread.archived
});

/**
 * Rename, archive or unarchive one of the owner's conversations by id (PRD §12). Nothing else
 * changes a conversation, and nothing deletes one (manage.ts THREAD_ACTIONS).
 *
 * - 200 {thread: {id, title, archived}}. Archiving an archived conversation, or unarchiving an
 *   open one, answers it as it is and writes nothing.
 * - 400: a body that is not an action, or a rename whose title is blank or too long.
 * - 404 for an id that is not the owner's conversation. Owner-only and Origin-checked by the
 *   guard; rate-limited ('coach.action').
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
	if (length > MAX_BODY_BYTES || text.length > MAX_BODY_BYTES) return invalid('At most 4 KB');
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return invalid('Body must be JSON');
	}
	const body = ActionBody.safeParse(raw);
	if (!body.success) return invalid('Body is not a conversation action');

	// The guard answers 401 without a session and 403 for a recovery one: this is the owner's.
	const ownerId = locals.session!.ownerId;
	try {
		const { action, title } = body.data;
		const thread =
			action === 'rename'
				? await renameThread(ownerId, params.id, title ?? '')
				: action === 'archive'
					? await archiveThread(ownerId, params.id)
					: await unarchiveThread(ownerId, params.id);
		return json({ thread: managed(thread) }, { headers: NO_STORE });
	} catch (err) {
		if (err instanceof CoachNotFoundError) {
			return json({ error: 'not_found' }, { status: 404, headers: NO_STORE });
		}
		if (err instanceof CoachInputError) return invalid(err.message, err.field);
		throw err;
	}
};
