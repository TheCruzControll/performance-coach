import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration. `pnpm db:generate` diffs the TypeScript schema against the
 * committed snapshots in ./drizzle/meta and writes a new SQL migration. Review and commit it.
 * Migrations are applied by `pnpm db:migrate` (scripts/db-migrate.ts), never by drizzle-kit push.
 */
export default defineConfig({
	dialect: 'postgresql',
	schema: './src/lib/server/db/schema/index.ts',
	out: './drizzle',
	dbCredentials: {
		url:
			process.env.DATABASE_URL_UNPOOLED ??
			process.env.DATABASE_URL ??
			'postgres://coach:coach@localhost:5432/coach_dev'
	},
	migrations: { schema: 'drizzle', table: '__drizzle_migrations' },
	strict: true,
	verbose: true
});
