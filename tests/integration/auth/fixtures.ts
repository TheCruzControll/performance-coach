import type { Executor } from '../../../src/lib/server/db';
import type { AuthRequest } from '../../../src/lib/server/auth/context';
import { beginSetup, completeSetup } from '../../../src/lib/server/auth/setup';
import { generateSetupToken, hashToken } from '../../../src/lib/server/auth/tokens';
import { SoftAuthenticator } from './soft-authenticator';

export const ORIGIN = 'http://localhost:4173';
export const RP = { rpID: 'localhost', origin: ORIGIN, rpName: 'Performance Coach' };
export const UA =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';

let ipCounter = 1;
/** A request from a fresh client address (so rate limits never couple unrelated steps). */
export function request(overrides: Partial<AuthRequest> = {}): AuthRequest {
	ipCounter += 1;
	return {
		rp: RP,
		ip: `198.51.100.${ipCounter % 250}`,
		userAgent: UA,
		requestId: `test-${ipCounter}`,
		...overrides
	};
}

/**
 * A setup token as `pnpm auth:setup-token` mints it. By default it expires far beyond any test
 * clock, so only the tests about expiry depend on it.
 */
export const newSetupToken = (expiresAt = new Date('2100-01-01T00:00:00Z')) =>
	generateSetupToken(expiresAt);

export const SETUP_TOKEN = newSetupToken();
export const SETUP_CONFIG = { tokenHash: hashToken(SETUP_TOKEN) };

/** A controllable clock. */
export function clock(start = new Date('2026-11-05T12:00:00Z')) {
	let t = start.getTime();
	return {
		now: () => new Date(t),
		advance: (ms: number) => {
			t += ms;
		}
	};
}

/**
 * Run first-run setup through the services with a software authenticator. `token` (default
 * `SETUP_TOKEN`) is the link's token; its hash is the configured one.
 */
export async function setUpOwner(
	db: Executor,
	options: {
		now?: () => Date;
		authenticator?: SoftAuthenticator;
		name?: string;
		token?: string;
	} = {}
) {
	const authenticator =
		options.authenticator ?? new SoftAuthenticator({ rpId: RP.rpID, origin: ORIGIN });
	const token = options.token ?? SETUP_TOKEN;
	const deps = { db, now: options.now, config: { tokenHash: hashToken(token) } };
	const opts = await beginSetup({ token, name: options.name ?? 'Niko Cruz' }, request(), deps);
	const result = await completeSetup(
		{ token, response: authenticator.register(opts) },
		undefined,
		request(),
		deps
	);
	return { ...result, authenticator, registrationOptions: opts };
}
