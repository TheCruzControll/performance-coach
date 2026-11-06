/**
 * Generate a one-time owner setup token and the hash the server is configured with.
 *
 *   pnpm auth:setup-token                                  # link for https://coach.nikocruz.com
 *   pnpm auth:setup-token --origin https://<preview>.vercel.app
 *   pnpm auth:setup-token --json
 *
 * Only the hash goes into the environment (OWNER_SETUP_TOKEN_HASH); the token itself is the
 * secret in the setup link and is printed here once, never stored. See docs/deployment.md
 * ("Owner setup") and docs/security.md.
 */
import { parseArgs } from 'node:util';
import { generateToken, hashToken } from '../src/lib/server/auth/tokens.ts';

const { values } = parseArgs({
	options: {
		origin: { type: 'string', default: 'https://coach.nikocruz.com' },
		json: { type: 'boolean', default: false }
	}
});

const origin = new URL(values.origin).origin;
const token = generateToken();
const hash = hashToken(token);
const link = `${origin}/setup?token=${token}`;

if (values.json) {
	console.log(JSON.stringify({ token, hash, link }, null, 2));
} else {
	console.log(
		[
			'',
			'Owner setup token — shown once. Do not commit it, paste it in chat, or log it.',
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
