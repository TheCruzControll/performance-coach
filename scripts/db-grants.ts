/**
 * Re-apply the runtime role's grants on a migrated database, as its owner. `pnpm db:migrate` and
 * `pnpm backup:restore` already do it. `scripts/restore-backup.sh` calls this after `pg_restore`.
 *
 *   pnpm db:grants "<owner direct URL>"
 *   DATABASE_URL_UNPOOLED=... pnpm db:grants
 *
 * A request for the grants is explicit, so a skip (the role is missing and this login cannot
 * create it) exits 1. The warning runtime-grants.ts prints before it carries the fix.
 */
import pg from 'pg';
import { isEntry } from './backup/cli-support.ts';
import { connectionConfig } from '../src/lib/server/db/connection.ts';
import { redactUrl } from '../src/lib/server/db/migrate.ts';
import {
	RUNTIME_ROLE,
	applyRuntimeGrants,
	isRuntimeRoleUrl,
	type RuntimeGrantsResult
} from '../src/lib/server/db/runtime-grants.ts';

/** The line and exit code for an explicit grants request. A skip is a failure: someone asked. */
export function grantsOutcome(
	result: RuntimeGrantsResult,
	redacted: string
): { exitCode: 0 | 1; line: string } {
	if (result.applied) {
		return { exitCode: 0, line: `db:grants: ${RUNTIME_ROLE} grants applied on ${redacted}` };
	}
	return {
		exitCode: 1,
		line: `db:grants: ${RUNTIME_ROLE} grants NOT applied on ${redacted}: the role is missing and this login cannot create it (the warning above has the fix)`
	};
}

async function runCli(argv: string[], env: NodeJS.ProcessEnv): Promise<void> {
	const url = argv[0] || env.DATABASE_URL_UNPOOLED || '';

	let parses = true;
	try {
		new URL(url);
	} catch {
		parses = false;
	}

	if (!url) {
		console.error("db:grants: pass the owner's direct URL, or set DATABASE_URL_UNPOOLED.");
		process.exitCode = 2;
	} else if (!parses) {
		// Never print the input: a malformed URL can still carry a password.
		console.error('not a postgres:// URL');
		process.exitCode = 2;
	} else if (isRuntimeRoleUrl(url)) {
		console.error(
			`db:grants: refusing ${redactUrl(url)}: it is the runtime role. Pass the owner's direct URL.`
		);
		process.exitCode = 2;
	} else {
		const client = new pg.Client({
			...connectionConfig(url),
			application_name: 'performance-coach-grants'
		});
		try {
			await client.connect();
			const outcome = grantsOutcome(await applyRuntimeGrants(client), redactUrl(url));
			if (outcome.exitCode === 0) console.log(outcome.line);
			else console.error(outcome.line);
			process.exitCode = outcome.exitCode;
		} catch (err) {
			console.error(`db:grants: failed on ${redactUrl(url)}`);
			console.error(err);
			process.exitCode = 1;
		} finally {
			await client.end().catch(() => {});
		}
	}
}

if (isEntry(import.meta.url)) await runCli(process.argv.slice(2), process.env);
