/**
 * Server hooks: startup validation, request context, the auth guard (deny by default),
 * Server-Timing, structured access logs, security headers and error recording.
 */
import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit/hooks';
import { building, version } from '$app/env';
import { emailLinkConfigured, emailLinkLogFields } from '#lib/server/auth/email-link-config.ts';
import { guardRequest } from '#lib/server/auth/guard.ts';
import { getEnv } from '#lib/server/env.ts';
import { createContext, runWithContext } from '#lib/server/observability/context.ts';
import { logger } from '#lib/server/observability/logger.ts';
import { serverTimingHeader } from '#lib/server/observability/timing.ts';
import { recordServerError } from '#lib/server/services/errors.ts';
import { shouldPreloadFont } from '#lib/ui/fonts.ts';

export const init: ServerInit = () => {
	if (building) return;
	// Fail fast on a misconfigured deployment: throws with every invalid variable listed.
	const env = getEnv();
	// The email sign-in link never stops the server: off, with the variables named, or on.
	logger.info('server ready', {
		appEnv: env.appEnv,
		version,
		node: process.version,
		...emailLinkLogFields(emailLinkConfigured())
	});
};

const REQUEST_ID = /^[\w.:-]{8,128}$/;

/**
 * Sent on every dynamic response (pages, endpoints). The Content-Security-Policy is set by
 * SvelteKit itself (`csp` in vite.config.ts). Static and prerendered files are served by the
 * CDN / adapter without running hooks; they hold no personal data, and the prerendered
 * /offline page carries its CSP as a <meta> tag.
 */
const SECURITY_HEADERS: Record<string, string> = {
	'x-content-type-options': 'nosniff',
	'x-frame-options': 'DENY',
	'referrer-policy': 'strict-origin-when-cross-origin',
	'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
	'cross-origin-opener-policy': 'same-origin',
	// Vercel adds HSTS on its domains; this covers any other host (ignored over plain HTTP).
	'strict-transport-security': 'max-age=63072000; includeSubDomains',
	// Private, single-user app: never indexed.
	'x-robots-tag': 'noindex, nofollow'
};

function withHeaders(response: Response, headers: Record<string, string>): Response {
	try {
		for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
		return response;
	} catch {
		// Immutable headers (e.g. a proxied fetch response): copy into a new Response.
		const copy = new Response(response.body, response);
		for (const [key, value] of Object.entries(headers)) copy.headers.set(key, value);
		return copy;
	}
}

export const handle: Handle = async ({ event, resolve }) => {
	const incoming =
		event.request.headers.get('x-request-id') ?? event.request.headers.get('x-vercel-id');
	const requestId = incoming && REQUEST_ID.test(incoming) ? incoming : crypto.randomUUID();
	event.locals.requestId = requestId;
	event.locals.session = null;

	const ctx = createContext(requestId);
	return runWithContext(ctx, async () => {
		// Every route needs a session unless src/lib/server/auth/routes.ts says otherwise.
		// Prerendering (build time) renders only public, data-free pages and has no database.
		const denied = building ? null : await guardRequest(event);
		const response =
			denied ??
			(await resolve(event, {
				preload: (input) =>
					input.type === 'js' ||
					input.type === 'css' ||
					(input.type === 'font' && shouldPreloadFont(input.filename))
			}));

		const durationMs = performance.now() - ctx.startedAt;
		const headers: Record<string, string> = {
			...SECURITY_HEADERS,
			'server-timing': serverTimingHeader(ctx, durationMs),
			'x-request-id': requestId
		};
		const type = response.headers.get('content-type') ?? '';
		if (type.startsWith('text/html') && !response.headers.has('cache-control')) {
			// Personal data will live in these pages: browsers may revalidate, CDNs must not store.
			headers['cache-control'] = 'private, no-cache';
		}

		if (!building) {
			const level = response.status >= 500 ? 'error' : 'info';
			logger[level]('request', {
				method: event.request.method,
				path: event.url.pathname,
				route: event.route.id,
				status: response.status,
				durationMs: Math.round(durationMs * 10) / 10
			});
		}
		return withHeaders(response, headers);
	});
};

export const handleError: HandleServerError = async ({ error, event, kind }) => {
	const requestId = event.locals.requestId ?? crypto.randomUUID();
	const status =
		kind === 'unknown' ? 500 : ((error as { status?: number } | undefined)?.status ?? 500);

	// Expected client errors (404s, invalid input) are logged but not recorded as incidents.
	if (status < 500) {
		logger.info('client error', { requestId, kind, status, path: event.url.pathname });
		return { requestId };
	}

	await recordServerError({
		error,
		kind,
		status,
		requestId,
		method: event.request.method,
		path: event.url.pathname,
		routeId: event.route.id,
		appVersion: version
	});
	return { message: 'Something went wrong on our side.', requestId };
};
