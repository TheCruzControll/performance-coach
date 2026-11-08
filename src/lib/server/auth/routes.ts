/**
 * Deny by default: the access policy of every route, keyed by SvelteKit route id.
 *
 * - `public`      no session needed: the sign-in screen, first-run setup, recovery sign-in, the
 *                 public auth endpoints, the health check, and the prerendered offline and
 *                 workout pages.
 * - `any-session` an owner session *or* the restricted session a recovery code grants (which
 *                 can do nothing but register a new passkey or sign out).
 * - `owner`       a full owner session. Everything else.
 *
 * The record is typed against SvelteKit's generated `RouteId` union, so adding a route without
 * classifying it fails `pnpm check`; `routes.test.ts` (unit) and `e2e/access.e2e.ts` also walk
 * `src/routes` and fail on any unclassified route. At runtime, a route id missing from this map
 * (or `null`, an unmatched URL) is treated as `owner`.
 */
import type { RouteId } from '$app/types';

export type RouteAccess = 'public' | 'any-session' | 'owner';

export const ROUTE_ACCESS = {
	// Sign-in, setup and recovery screens
	'/': 'public',
	'/setup': 'public',
	'/recover': 'public',
	'/recover/passkey': 'any-session',
	// Public auth endpoints (rate-limited) and the health check
	'/api/auth/signin/options': 'public',
	'/api/auth/signin/verify': 'public',
	'/api/auth/setup/options': 'public',
	'/api/auth/setup/verify': 'public',
	'/api/auth/signout': 'public', // clears whatever the device holds, signed in or not
	'/api/health': 'public',
	// Prerendered offline fallback (served statically; holds no personal data)
	'/(app)/offline': 'public',
	// Prerendered workout pages (data-free HTML; the workout lives in IndexedDB on the device)
	'/workout': 'public',
	'/workout/run': 'public',
	'/workout/session': 'public',
	// Test-only: 404 unless ENABLE_TEST_ROUTES (never allowed on a hosted deployment)
	'/api/test-support/session': 'public',
	'/api/test-support/error': 'owner',
	'/api/test-support/program': 'owner',
	'/api/test-support/analytics': 'owner',

	// Adding a passkey: a signed-in owner, or a recovery session replacing a lost passkey
	'/api/auth/passkeys/options': 'any-session',
	'/api/auth/passkeys/verify': 'any-session',

	// Step-up re-authentication: a full owner session confirms with one of its passkeys
	'/api/auth/reauth/options': 'owner',
	'/api/auth/reauth/verify': 'owner',

	// The app
	'/(app)/today': 'owner',
	'/(app)/train': 'owner',
	'/(app)/train/session/[key]': 'owner',
	'/(app)/train/history/[[version]]': 'owner',
	'/(app)/progress': 'owner',
	'/(app)/coach': 'owner',
	'/(app)/profile': 'owner',
	'/(app)/profile/security': 'owner',
	'/(app)/profile/[section]': 'owner',
	'/onboarding/[[step]]': 'owner',
	'/design': 'owner',
	'/api/vitals': 'owner',
	'/api/client-errors': 'owner',

	// Coach (M5): owner-only, Origin-checked and rate-limited; one anchor per area, each slice adds
	// its line under its own.
	// turns
	'/api/coach/turns': 'owner',

	// runs
	'/api/coach/runs/[run]/cancel': 'owner',

	// threads

	// proposals

	// memory

	// Workouts (M4): owner-only JSON, one anchor per area; each slice adds its line under its own.
	// sync
	'/api/workouts/sync': 'owner',

	// reads
	'/api/workouts/[id]': 'owner',
	'/api/workouts/active': 'owner'

	// kit

	// history

	// exercises
} as const satisfies Record<RouteId, RouteAccess>;

export function routeAccess(routeId: string | null): RouteAccess {
	return (routeId && (ROUTE_ACCESS as Record<string, RouteAccess>)[routeId]) || 'owner';
}

/** Where a recovery session is sent until it has registered a new passkey. */
export const RECOVERY_PASSKEY_PATH = '/recover/passkey';
