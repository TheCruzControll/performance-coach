import { error } from '@sveltejs/kit';
import { version } from '$app/env';
import { InvalidVitalsError, recordVitals } from '#lib/server/services/vitals.ts';
import type { RequestHandler } from './$types';

const MAX_BODY_BYTES = 16 * 1024;

/** Ingest Web Vitals beacons from src/lib/client/vitals.ts. */
export const POST: RequestHandler = async ({ request }) => {
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
		await recordVitals(payload, {
			appVersion: version,
			userAgent: request.headers.get('user-agent')
		});
	} catch (err) {
		if (err instanceof InvalidVitalsError) error(422, err.issues.slice(0, 5).join('; '));
		throw err;
	}
	return new Response(null, { status: 204 });
};
