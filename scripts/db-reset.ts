/**
 * Recreate a disposable database (test or e2e) from scratch and apply all migrations.
 *
 *   pnpm db:reset:test   # TEST_DATABASE_URL (default: local coach_test)
 *   pnpm db:reset:e2e    # E2E_DATABASE_URL  (default: local coach_e2e)
 *
 * Guarded: refuses any database whose name does not end in _test or _e2e.
 */
import { parseArgs } from 'node:util';
import { LOCAL_DATABASE_URLS, redactUrl, resetDatabase } from '../src/lib/server/db/migrate.ts';

const { values } = parseArgs({ options: { target: { type: 'string', default: 'test' } } });
const target = values.target === 'e2e' ? 'e2e' : 'test';
const url =
	(target === 'e2e' ? process.env.E2E_DATABASE_URL : process.env.TEST_DATABASE_URL) ||
	LOCAL_DATABASE_URLS[target];

try {
	const { total } = await resetDatabase(url);
	console.log(`db:reset:${target}: recreated ${redactUrl(url)} with ${total} migration(s)`);
} catch (err) {
	console.error(`db:reset:${target}: failed on ${redactUrl(url)}`);
	console.error(err);
	process.exit(1);
}
