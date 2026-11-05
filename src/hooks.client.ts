/**
 * Client hooks.
 * - Errors are reported to the server (src/lib/client/errors.ts → POST /api/client-errors →
 *   `app_errors`, kind `client`): uncaught exceptions and unhandled rejections from `init`, and
 *   unexpected errors during navigation from `handleError`.
 * - A failed network request during client-side navigation (offline, "lie-fi", a dropped
 *   connection) is not an error worth reporting: it is marked so the error views render the
 *   designed offline state (src/routes/ErrorView.svelte) instead of "500 · Internal Error".
 */
import type { ClientInit, HandleClientError } from '@sveltejs/kit/hooks';
import { version } from '$app/env';
import { reportClientError, setErrorContext, startErrorReporting } from '#lib/client/errors.ts';

export const init: ClientInit = () => {
	setErrorContext(null, version);
	startErrorReporting();
};

/** Fetch / dynamic-import network failures as worded by Chromium, WebKit and Gecko. */
const NETWORK_FAILURE =
	/failed to fetch|load failed|networkerror|network connection was lost|importing a module script failed|error loading dynamically imported module/i;

function isNetworkFailure(error: unknown): boolean {
	return error instanceof TypeError && NETWORK_FAILURE.test(error.message);
}

export const handleError: HandleClientError = ({ kind, error }) => {
	if (kind !== 'unknown') return; // app/framework errors (e.g. 404) keep their own status
	if (!navigator.onLine || isNetworkFailure(error)) {
		return { message: "You're offline", offline: true };
	}
	console.error(error);
	reportClientError(error, 'handleError');
};
