/**
 * Client hooks. A failed network request during client-side navigation (offline, "lie-fi",
 * a dropped connection) is not a server error: mark it so the error views render the designed
 * offline state (src/routes/ErrorView.svelte) instead of "500 · Internal Error".
 */
import type { HandleClientError } from '@sveltejs/kit/hooks';

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
};
