import { error } from '@sveltejs/kit';
import {
	ClientErrorRateLimited,
	InvalidClientErrorReport,
	recordClientError
} from '#lib/server/services/client-errors.ts';
import type { RequestHandler } from './$types';

const MAX_BODY_BYTES = 16 * 1024;

/** Ingest browser error reports from src/lib/client/errors.ts into app_errors (kind `client`). */
export const POST: RequestHandler = async ({ request, locals }) => {
	const length = Number(request.headers.get('content-length') ?? 0);
	if (length > MAX_BODY_BYTES) error(413, 'Payload too large');

	const text = await request.text();
	if (text.length > MAX_BODY_BYTES) error(413, 'Payload too large');

	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch {
		error(400, 'Body must be JSON');
	}

	try {
		await recordClientError(payload, {
			requestId: locals.requestId,
			userAgent: request.headers.get('user-agent')
		});
	} catch (err) {
		if (err instanceof InvalidClientErrorReport) error(422, err.issues.slice(0, 5).join('; '));
		if (err instanceof ClientErrorRateLimited) error(429, 'Too many error reports');
		throw err;
	}
	return new Response(null, { status: 204 });
};
