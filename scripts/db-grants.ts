/**
 * Re-apply the runtime role's grants on a migrated database, as its owner. `pnpm db:migrate` and
 * `pnpm backup:restore` already do it. `scripts/restore-backup.sh` calls this after `pg_restore`.
 *
 *   pnpm db:grants "<owner direct URL>"
 *   DATABASE_URL_UNPOOLED=... pnpm db:grants
 */
import pg from 'pg';
import { connectionConfig } from '../src/lib/server/db/connection.ts';
import { redactUrl } from '../src/lib/server/db/migrate.ts';
import {
	RUNTIME_ROLE,
	applyRuntimeGrants,
	isRuntimeRoleUrl
} from '../src/lib/server/db/runtime-grants.ts';

const url = process.argv[2] || process.env.DATABASE_URL_UNPOOLED || '';

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
		await applyRuntimeGrants(client);
		console.log(`db:grants: ${RUNTIME_ROLE} grants applied on ${redactUrl(url)}`);
	} catch (err) {
		console.error(`db:grants: failed on ${redactUrl(url)}`);
		console.error(err);
		process.exitCode = 1;
	} finally {
		await client.end().catch(() => {});
	}
}
