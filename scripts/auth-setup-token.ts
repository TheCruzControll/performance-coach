/**
 * Generate a one-time owner setup token and the hash the server is configured with.
 *
 *   pnpm auth:setup-token                                  # link for https://coach.nikocruz.com
 *   pnpm auth:setup-token --origin https://<preview>.vercel.app
 *   pnpm auth:setup-token --hours 48                       # expires in 48 h (default 24, max 168)
 *   pnpm auth:setup-token --json
 *
 * Only the hash goes into the environment (OWNER_SETUP_TOKEN_HASH); the token itself is the
 * secret in the setup link and is printed here once, never stored. The token carries its own
 * expiry, covered by the hash, so a hash left configured stops working on its own. See
 * docs/deployment.md ("Owner setup") and docs/security.md.
 */
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { generateSetupToken, hashToken } from '../src/lib/server/auth/tokens.ts';

/** How long a setup link works unless --hours says otherwise (owner decision, ASVS 2.3.1). */
export const SETUP_TOKEN_DEFAULT_HOURS = 24;
/** The longest a setup link may work: one week. */
export const SETUP_TOKEN_MAX_HOURS = 168;

/** --hours as a whole number of hours from 1 to SETUP_TOKEN_MAX_HOURS, or null. */
export function parseHours(value: string): number | null {
	if (!/^\d+$/.test(value)) return null;
	const hours = Number(value);
	return hours >= 1 && hours <= SETUP_TOKEN_MAX_HOURS ? hours : null;
}

/** A new setup token valid for `hours` from `now`, with the hash to configure. */
export function mintSetupToken(hours = SETUP_TOKEN_DEFAULT_HOURS, now = new Date()) {
	const expiresAt = new Date(Math.floor(now.getTime() / 1000) * 1000 + hours * 3_600_000);
	const token = generateSetupToken(expiresAt);
	return { token, hash: hashToken(token), expiresAt };
}

function main() {
	const { values } = parseArgs({
		options: {
			origin: { type: 'string', default: 'https://coach.nikocruz.com' },
			hours: { type: 'string', default: String(SETUP_TOKEN_DEFAULT_HOURS) },
			json: { type: 'boolean', default: false }
		}
	});
	const hours = parseHours(values.hours);
	if (hours === null) {
		console.error(`--hours must be a whole number from 1 to ${SETUP_TOKEN_MAX_HOURS}.`);
		process.exitCode = 1;
		return;
	}

	const origin = new URL(values.origin).origin;
	const { token, hash, expiresAt } = mintSetupToken(hours);
	const link = `${origin}/setup?token=${token}`;
	const utc = expiresAt.toISOString().replace(/\.000Z$/, 'Z');
	const local = expiresAt.toLocaleString('en-GB', {
		weekday: 'short',
		day: 'numeric',
		month: 'short',
		year: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		timeZoneName: 'short'
	});

	if (values.json) {
		console.log(JSON.stringify({ token, hash, link, expiresAt: utc }, null, 2));
		return;
	}
	console.log(
		[
			'',
			'Owner setup token — shown once. Do not commit it, paste it in chat, or log it.',
			'',
			`It expires in ${hours} h: ${utc} (UTC), ${local} on this machine.`,
			'After that the link answers 404 and setup needs a new token from this command.',
			'',
			'1. Set this on Vercel (Project → Settings → Environment Variables), sensitive, for the',
			'   environment being set up (Production for coach.nikocruz.com), then redeploy:',
			'',
			`   OWNER_SETUP_TOKEN_HASH=${hash}`,
			'',
			'2. Give the owner this link through a private channel. It works for one setup: once the',
			'   first passkey is registered with it, it answers 404 for good, even after an owner reset:',
			'',
			`   ${link}`,
			'',
			'3. After setup, remove OWNER_SETUP_TOKEN_HASH from Vercel. After `pnpm auth:reset-owner`,',
			'   run this again: setup needs a new token (the used one stays refused).',
			''
		].join('\n')
	);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
