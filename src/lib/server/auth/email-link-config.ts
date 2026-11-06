/**
 * Whether the email sign-in link (ADR 0011) is on, and with which provider. Pure: depends only on
 * its inputs (unit-tested in email-link-config.test.ts); `emailLinkConfigured()` applies it to
 * this server's environment once.
 *
 * The three variables never stop the server. env.ts reads them leniently (trimmed, blank means
 * unset) and this module decides: a missing or invalid one switches the feature off and is named
 * in the startup log, never its value. Production therefore works as before until the owner sets
 * them.
 *
 * - **Preview** (appEnv or VERCEL_ENV): always off, whatever is set.
 * - **Test provider** (records messages) whenever test routes are enabled and allowed
 *   (`testRoutesEnabled()`), even with a key, so a test server can never send real mail. Never on
 *   Vercel or in a server built for Vercel.
 * - **Resend** otherwise, which needs `RESEND_API_KEY` (prefix `re_`).
 * - `OWNER_EMAIL` is the only recipient: exactly one address, lower-cased.
 * - `EMAIL_FROM` is optional: an address or `Name <address>`; `DEFAULT_EMAIL_FROM` when unset.
 */
import { z } from 'zod';
import { getEnv, testRoutesEnabled, type Env } from '../env';

/**
 * The sender until the owner verifies nikocruz.com in Resend: Resend's shared onboarding address,
 * which delivers only to the address that owns the Resend account. Set EMAIL_FROM to change it.
 */
export const DEFAULT_EMAIL_FROM = 'Performance Coach <onboarding@resend.dev>';

/** Every Resend API key starts with `re_`; anything else is a pasted key from another service. */
const RESEND_API_KEY_PATTERN = /^re_[\w-]+$/;

/** One plain address (no display name, no list), at most the 254 characters SMTP allows. */
const ADDRESS = z.email().max(254);

/** `Name <address>`. The name may not hold control characters (header injection), quotes or `\`. */
const NAMED_SENDER = /^(?<name>[^<>]*)<(?<address>[^<>]*)>$/;
const UNSAFE_NAME = /[\p{Cc}"\\]/u;

export type EmailLinkVariable = 'OWNER_EMAIL' | 'RESEND_API_KEY' | 'EMAIL_FROM';
export type EmailLinkProvider = 'resend' | 'test';

export type EmailLinkConfig =
	| { enabled: true; provider: 'resend'; ownerEmail: string; from: string; apiKey: string }
	| { enabled: true; provider: 'test'; ownerEmail: string; from: string }
	| {
			enabled: false;
			/** `preview`: previews never send. `configuration`: see `missing` and `invalid`. */
			reason: 'preview' | 'configuration';
			missing: EmailLinkVariable[];
			invalid: EmailLinkVariable[];
	  };

export type EmailLinkEnv = Pick<
	Env,
	'appEnv' | 'VERCEL' | 'VERCEL_ENV' | 'OWNER_EMAIL' | 'RESEND_API_KEY' | 'EMAIL_FROM'
>;

/** Replaced at build time by vite.config.ts (see env.ts): `true` in a build for Vercel. */
declare const __VERCEL_BUILD__: boolean | undefined;

/** Defence in depth over `testRoutesEnabled()`: a hosted server never records mail. */
function onVercel(env: EmailLinkEnv): boolean {
	if (typeof __VERCEL_BUILD__ !== 'undefined' && __VERCEL_BUILD__) return true;
	return Boolean(env.VERCEL) || env.VERCEL_ENV !== undefined;
}

const isAddress = (value: string) => ADDRESS.safeParse(value).success;

function isSender(value: string): boolean {
	const named = NAMED_SENDER.exec(value);
	if (!named?.groups) return isAddress(value);
	const name = named.groups.name?.trim() ?? '';
	return name !== '' && !UNSAFE_NAME.test(name) && isAddress(named.groups.address ?? '');
}

/**
 * The email link's configuration. `testRoutes` is whether test routes are enabled and allowed
 * here (`testRoutesEnabled(env)`).
 */
export function emailLinkConfig(
	env: EmailLinkEnv,
	{ testRoutes }: { testRoutes: boolean }
): EmailLinkConfig {
	if (env.appEnv === 'preview' || env.VERCEL_ENV === 'preview') {
		return { enabled: false, reason: 'preview', missing: [], invalid: [] };
	}
	const provider: EmailLinkProvider = testRoutes && !onVercel(env) ? 'test' : 'resend';
	const missing: EmailLinkVariable[] = [];
	const invalid: EmailLinkVariable[] = [];

	const ownerEmail = env.OWNER_EMAIL;
	if (ownerEmail === undefined) missing.push('OWNER_EMAIL');
	else if (!isAddress(ownerEmail)) invalid.push('OWNER_EMAIL');

	// Set only for Resend with a valid key: the test provider never carries the key.
	let apiKey: string | undefined;
	if (provider === 'resend') {
		const key = env.RESEND_API_KEY;
		if (key === undefined) missing.push('RESEND_API_KEY');
		else if (!RESEND_API_KEY_PATTERN.test(key)) invalid.push('RESEND_API_KEY');
		else apiKey = key;
	}

	const from = env.EMAIL_FROM ?? DEFAULT_EMAIL_FROM;
	if (!isSender(from)) invalid.push('EMAIL_FROM');

	if (ownerEmail === undefined || missing.length > 0 || invalid.length > 0) {
		return { enabled: false, reason: 'configuration', missing, invalid };
	}
	const owner = ownerEmail.toLowerCase();
	if (apiKey !== undefined) {
		return { enabled: true, provider: 'resend', ownerEmail: owner, from, apiKey };
	}
	return { enabled: true, provider: 'test', ownerEmail: owner, from };
}

/** The startup log's fields: the provider, or why it is off with the variables' names only. */
export function emailLinkLogFields(config: EmailLinkConfig): Record<string, unknown> {
	if (config.enabled) return { emailSignIn: config.provider };
	return {
		emailSignIn: 'off',
		emailSignInOff: config.reason,
		emailSignInMissing: config.missing,
		emailSignInInvalid: config.invalid
	};
}

let memo: { env: Env; config: EmailLinkConfig } | undefined;

/** This server's configuration, for routes: computed once per parsed environment. */
export function emailLinkConfigured(): EmailLinkConfig {
	const env = getEnv();
	if (memo?.env !== env) {
		memo = { env, config: emailLinkConfig(env, { testRoutes: testRoutesEnabled(env) }) };
	}
	return memo.config;
}
