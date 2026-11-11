/**
 * The closed-week rollups' backfill, as `pnpm db:migrate` runs it after the migrations and the
 * catalogue seed (so every deployed build): backfillStrengthWeeks writes each closed week not yet
 * written, so Progress reads existing data from the rollups before the first sync.
 *
 * The service is written for Vite, whose relative imports name no extension. Plain Node needs
 * one, so this module first adds a resolve hook that tries `.ts` and `/index.ts` for a relative
 * specifier without one, then loads the service. scripts/catalogue-node.test.ts loads it under
 * plain Node, so a specifier the hook cannot resolve fails there and not in a deploy.
 */
import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { connectionConfig } from '../../src/lib/server/db/connection.ts';

registerHooks({
	resolve(specifier, context, next) {
		const parent = context.parentURL;
		if (
			specifier.startsWith('.') &&
			!/\.[cm]?[jt]s$/.test(specifier) &&
			parent?.startsWith('file:')
		)
			for (const suffix of ['.ts', '/index.ts']) {
				const url = new URL(specifier + suffix, parent);
				if (existsSync(fileURLToPath(url))) return next(url.href, context);
			}
		return next(specifier, context);
	}
});

const { backfillStrengthWeeks } =
	await import('../../src/lib/server/services/analytics/strength-weeks.ts');
const schema = await import('../../src/lib/server/db/schema/index.ts');

/** Write the owner's unwritten closed weeks on the database at `url`: how many were. */
export async function backfillWeeks(url: string, now = new Date()): Promise<number> {
	const client = new pg.Client({
		...connectionConfig(url),
		application_name: 'performance-coach-backfill'
	});
	await client.connect();
	try {
		return await backfillStrengthWeeks(drizzle({ client, schema }), now);
	} finally {
		await client.end();
	}
}
