/**
 * Apply committed SQL migrations (./drizzle) to the target database, then seed the exercise
 * catalogue (runMigrations does both, under one lock).
 *
 *   pnpm db:migrate                  # uses DATABASE_URL_UNPOOLED, else DATABASE_URL
 *   DATABASE_URL_UNPOOLED=... pnpm db:migrate
 *
 * Always use a direct (non-pooled) connection for migrations (Neon: host without `-pooler`).
 */
import { LOCAL_DATABASE_URLS, redactUrl, runMigrations } from '../src/lib/server/db/migrate.ts';

const url =
	process.env.DATABASE_URL_UNPOOLED ||
	process.env.DATABASE_URL ||
	(process.env.CI ? '' : LOCAL_DATABASE_URLS.development);

if (!url) {
	console.error('db:migrate: set DATABASE_URL_UNPOOLED (or DATABASE_URL).');
	process.exit(1);
}

const started = performance.now();
try {
	const { applied, total, library } = await runMigrations(url);
	const ms = Math.round(performance.now() - started);
	console.log(
		`db:migrate: ${applied} new migration(s) applied, ${total} total on ${redactUrl(url)} (${ms} ms)`
	);
	console.log(
		`db:migrate: exercise catalogue ${library.inserted} inserted, ${library.updated} updated, ` +
			`${library.retired} retired, ${library.restored} restored`
	);
} catch (err) {
	console.error(`db:migrate: failed on ${redactUrl(url)}`);
	console.error(err);
	process.exit(1);
}
