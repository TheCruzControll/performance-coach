/**
 * Lost every passkey *and* every recovery code? Reset the owner's credentials so first-run
 * setup can run again. Guarded: it refuses to run without `--confirm`, without
 * DATABASE_URL_UNPOOLED (there is no default database: never DATABASE_URL, never a local one)
 * and outside an interactive terminal; it shows exactly what it will do to which database and
 * asks for the database name to be typed back.
 *
 *   DATABASE_URL_UNPOOLED='postgres://…neon…/neondb' pnpm auth:reset-owner --confirm
 *
 * What it does (one transaction): deletes every passkey, recovery code, email sign-in link and
 * pending challenge, revokes every session, reopens setup (owners.setup_completed_at = null) and writes an
 * `owner.reset` audit event. The owner row and all training data are kept: the next setup
 * re-attaches to the same owner. Then issue a new setup link (`pnpm auth:setup-token`): used setup
 * tokens stay recorded, so the previous link keeps answering 404.
 * Procedure: docs/deployment.md ("Lost passkeys").
 */
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { connectionConfig } from '../src/lib/server/db/connection.ts';
import { databaseName, redactUrl } from '../src/lib/server/db/migrate.ts';

export interface ResetSummary {
	ownerName: string | null;
	passkeys: number;
	sessions: number;
	recoveryCodes: number;
	emailLinks: number;
}

/**
 * The reset itself, in one transaction (exported for the integration test, which runs it
 * inside its own rolled-back transaction with `transaction: false`).
 */
export async function resetOwnerAuth(
	client: Pick<pg.ClientBase, 'query'>,
	options: { transaction?: boolean } = {}
): Promise<ResetSummary> {
	const own = options.transaction ?? true;
	if (own) await client.query('begin');
	try {
		await client.query('select pg_advisory_xact_lock(727002)'); // same lock as setup
		const owner = await client.query<{ id: string; display_name: string }>(
			'select id, display_name from owners for update'
		);
		const ownerId = owner.rows[0]?.id ?? null;
		const sessions = await client.query(
			`update auth_sessions set revoked_at = now(), revoked_reason = 'owner_reset'
			 where revoked_at is null`
		);
		const passkeys = await client.query('delete from passkey_credentials');
		const codes = await client.query('delete from recovery_codes');
		const links = await client.query('delete from email_sign_in_links');
		await client.query('delete from webauthn_challenges');
		await client.query('update owners set setup_completed_at = null');
		await client.query(
			`insert into auth_events (type, owner_id, detail) values ('owner.reset', $1, $2)`,
			[
				ownerId,
				JSON.stringify({
					passkeys: passkeys.rowCount,
					sessions: sessions.rowCount,
					recoveryCodes: codes.rowCount,
					emailLinks: links.rowCount
				})
			]
		);
		if (own) await client.query('commit');
		return {
			ownerName: owner.rows[0]?.display_name ?? null,
			passkeys: passkeys.rowCount ?? 0,
			sessions: sessions.rowCount ?? 0,
			recoveryCodes: codes.rowCount ?? 0,
			emailLinks: links.rowCount ?? 0
		};
	} catch (err) {
		if (own) await client.query('rollback');
		throw err;
	}
}

/**
 * The database to reset: only ever the one named explicitly by DATABASE_URL_UNPOOLED (the direct
 * connection, as for migrations). No fallback to DATABASE_URL or a local default, so a missing
 * variable can never point the reset at whatever database happens to be configured.
 */
export function resetTarget(env: Record<string, string | undefined>): string | null {
	const url = env.DATABASE_URL_UNPOOLED?.trim();
	return url ? url : null;
}

async function main() {
	const { values } = parseArgs({ options: { confirm: { type: 'boolean', default: false } } });
	const url = resetTarget(process.env);
	if (!url) {
		console.error(
			'Refusing to run: set DATABASE_URL_UNPOOLED to the direct (non-pooled) connection string of\n' +
				'the database to reset (Neon → production branch → direct connection). There is no default.'
		);
		process.exitCode = 2;
		return;
	}
	const name = databaseName(url);
	const host = new URL(url).hostname;

	const client = new pg.Client({ ...connectionConfig(url), application_name: 'auth-reset-owner' });
	await client.connect();
	try {
		const state = await client.query<{
			owner: string | null;
			passkeys: number;
			sessions: number;
			links: number;
		}>(
			`select (select display_name from owners limit 1) as owner,
			        (select count(*)::int from passkey_credentials) as passkeys,
			        (select count(*)::int from auth_sessions where revoked_at is null) as sessions,
			        (select count(*)::int from email_sign_in_links) as links`
		);
		const { owner, passkeys, sessions, links } = state.rows[0]!;
		console.log(
			[
				'',
				`Database: ${redactUrl(url)}`,
				`Owner:    ${owner ?? '(none yet)'}`,
				`Will delete ${passkeys} passkey(s), ${links} email sign-in link(s) and every recovery code,`,
				`revoke ${sessions} session(s)`,
				'and reopen first-run setup. Training data is kept.',
				''
			].join('\n')
		);
		if (!values.confirm) {
			console.error('Refusing to run without --confirm.');
			process.exitCode = 2;
			return;
		}
		if (!stdin.isTTY) {
			console.error('Refusing to run non-interactively: type the confirmation in a terminal.');
			process.exitCode = 2;
			return;
		}
		const rl = createInterface({ input: stdin, output: stdout });
		const typed = (
			await rl.question(`Type the database name (${name}@${host}) to continue: `)
		).trim();
		rl.close();
		if (typed !== `${name}@${host}`) {
			console.error('Confirmation did not match. Nothing changed.');
			process.exitCode = 1;
			return;
		}
		const summary = await resetOwnerAuth(client);
		console.log(
			[
				'',
				`Reset done: ${summary.passkeys} passkey(s), ${summary.recoveryCodes} recovery code(s) and ${summary.emailLinks} email sign-in link(s) deleted, ${summary.sessions} session(s) revoked.`,
				'Next: `pnpm auth:setup-token` (a new token: the previous link stays refused), set',
				'OWNER_SETUP_TOKEN_HASH on Vercel, redeploy, send the link.',
				''
			].join('\n')
		);
	} finally {
		await client.end();
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	await main();
}
