/**
 * Vitest global setup for integration tests: recreate the disposable test database and apply
 * every committed migration, exactly as production would (`pnpm db:migrate`).
 */
import { LOCAL_DATABASE_URLS, redactUrl, resetDatabase } from '../../src/lib/server/db/migrate';

export default async function setup(): Promise<void> {
	const url = process.env.TEST_DATABASE_URL || LOCAL_DATABASE_URLS.test;
	try {
		await resetDatabase(url);
	} catch (err) {
		throw new Error(
			`Integration tests need a reachable Postgres test database at ${redactUrl(url)}.\n` +
				`Run \`pnpm db:setup\` (local Postgres 16) or set TEST_DATABASE_URL.\nCause: ${String(err)}`,
			{ cause: err }
		);
	}
}
