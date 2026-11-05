/**
 * WebAuthn relying party (RP ID + expected origin) for a request — the one audited place that
 * decides which site passkeys are bound to. Pure: depends only on its inputs (unit-tested in
 * relying-party.test.ts).
 *
 * - **production** (appEnv or VERCEL_ENV `production`): exactly `https://coach.nikocruz.com`,
 *   RP ID `coach.nikocruz.com`, whatever host the request arrived on. A request on any other
 *   host (e.g. the deployment's `*.vercel.app` URL) is refused: passkeys work only on the
 *   production domain.
 * - **preview**: the deployment's own HTTPS host (`VERCEL_URL`, `VERCEL_BRANCH_URL`, or another
 *   `*.vercel.app` alias). Never the production domain or anything under `nikocruz.com`: a
 *   preview must not be able to request or accept assertions for the production RP. Each
 *   `*.vercel.app` host is its own site (vercel.app is on the Public Suffix List).
 * - **development / test**: `localhost` only (any port, http or https). WebAuthn forbids IP
 *   addresses as RP IDs, so 127.0.0.1 is refused with a hint.
 */
import type { AppEnv } from '../env';

export const PRODUCTION_RP_ID = 'coach.nikocruz.com';
export const PRODUCTION_ORIGIN = `https://${PRODUCTION_RP_ID}`;
export const RP_NAME = 'Performance Coach';

/** The owner's registrable domain: no non-production deployment may use an RP ID under it. */
const OWNER_DOMAIN = 'nikocruz.com';

export interface RelyingPartyEnv {
	appEnv: AppEnv;
	VERCEL_ENV?: 'production' | 'preview' | 'development';
	VERCEL_URL?: string;
	VERCEL_BRANCH_URL?: string;
}

export interface RelyingParty {
	/** WebAuthn RP ID (a host name). */
	rpID: string;
	/** The only origin assertions and attestations are accepted from. */
	origin: string;
	rpName: string;
}

export type RelyingPartyResult =
	({ ok: true } & RelyingParty) | { ok: false; reason: string; signInUrl?: string };

const hostOf = (value: string | undefined) =>
	value
		?.trim()
		.replace(/^https?:\/\//, '')
		.replace(/\/.*$/, '')
		.toLowerCase() || undefined;

function isUnder(host: string, domain: string): boolean {
	return host === domain || host.endsWith(`.${domain}`);
}

export function isProductionEnv(env: RelyingPartyEnv): boolean {
	return env.appEnv === 'production' || env.VERCEL_ENV === 'production';
}

export function relyingPartyFor(env: RelyingPartyEnv, requestUrl: URL): RelyingPartyResult {
	const host = requestUrl.hostname.toLowerCase();

	if (isProductionEnv(env)) {
		// Exact match only: scheme, host and (default) port.
		if (requestUrl.origin !== PRODUCTION_ORIGIN) {
			return {
				ok: false,
				reason: `Passkeys work only on ${PRODUCTION_ORIGIN}.`,
				signInUrl: PRODUCTION_ORIGIN
			};
		}
		return { ok: true, rpID: PRODUCTION_RP_ID, origin: PRODUCTION_ORIGIN, rpName: RP_NAME };
	}

	if (env.appEnv === 'preview' || env.VERCEL_ENV === 'preview') {
		if (requestUrl.protocol !== 'https:') {
			return { ok: false, reason: 'Preview deployments sign in over HTTPS only.' };
		}
		if (isUnder(host, OWNER_DOMAIN)) {
			return {
				ok: false,
				reason: 'A preview deployment never uses the production passkey domain.'
			};
		}
		const own = [hostOf(env.VERCEL_URL), hostOf(env.VERCEL_BRANCH_URL)].filter(Boolean);
		if (!own.includes(host) && !host.endsWith('.vercel.app')) {
			return { ok: false, reason: `Unknown preview host ${host}.` };
		}
		return { ok: true, rpID: host, origin: requestUrl.origin, rpName: `${RP_NAME} (preview)` };
	}

	// development / test
	if (host !== 'localhost') {
		return {
			ok: false,
			reason:
				host === '127.0.0.1' || host === '[::1]'
					? 'Open the app on http://localhost (passkeys cannot use an IP address).'
					: `Local passkeys work on localhost only, not ${host}.`
		};
	}
	return { ok: true, rpID: 'localhost', origin: requestUrl.origin, rpName: RP_NAME };
}
