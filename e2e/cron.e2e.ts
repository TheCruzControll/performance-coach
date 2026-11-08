/**
 * The daily backup cron (vercel.json → GET /api/cron/backup) through the production-built server,
 * called as Vercel Cron calls it: `Authorization: Bearer <CRON_SECRET>`. global-setup.ts gives
 * the server this run's random secret and key, and a folder store under test-results. The answer
 * carries names, sizes and counts only, and the file it names opens in Node with the key, with
 * every table's row count equal to Postgres's.
 *
 * Chromium only: the request fixture is engine-agnostic, so a second engine would prove nothing
 * more. Refusals (signed out, the owner's session, other methods) are in access.e2e.ts.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { readArchive } from '../src/lib/server/backup/archive';
import { openEnvelope } from '../src/lib/server/backup/envelope';
import { parseBackupKey } from '../src/lib/server/backup/key';
import { E2E_BACKUP_DIR } from './global-setup';
import { query, signedOut } from './support';

test.use({ storageState: signedOut });
test.skip(({ browserName }) => browserName !== 'chromium', 'one engine proves an HTTP-only route');
test.skip(!process.env.E2E_CRON_SECRET, 'the server under test was not started with a secret');

/** Every public table's row count, in one statement. */
async function counts(): Promise<Map<string, number>> {
	const rows = await query<{ name: string; n: number }>(
		`select table_name as name,
			(xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', table_name),
				false, true, '')))[1]::text::int as n
		 from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'`
	);
	return new Map(rows.map((row) => [row.name, row.n]));
}

test('the bearer runs one verified backup whose file matches Postgres, answering no row', async ({
	request
}) => {
	const before = await counts();
	const res = await request.get('/api/cron/backup', {
		headers: { authorization: `Bearer ${process.env.E2E_CRON_SECRET}` },
		timeout: 60_000
	});
	expect(res.status(), await res.text()).toBe(200);
	expect(res.headers()['cache-control']).toBe('no-store');
	const body = (await res.json()) as Record<string, unknown>;
	expect(Object.keys(body)).toEqual([
		'status',
		'pathname',
		'bytes',
		'sha256',
		'tables',
		'rows',
		'durationMs'
	]);
	expect(body).toMatchObject({ status: 'ok', pathname: expect.any(String) });

	const file = readFileSync(path.join(E2E_BACKUP_DIR, String(body.pathname)));
	expect(body.bytes).toBe(file.length);
	expect(body.sha256).toBe(createHash('sha256').update(file).digest('hex'));
	const key = parseBackupKey(process.env.E2E_BACKUP_KEY!, 'E2E_BACKUP_KEY');
	const archive = readArchive(openEnvelope(key, file));
	expect(archive.tables.length).toBe(body.tables);
	expect(archive.tables.map((t) => t.name)).toEqual(expect.arrayContaining(['owners']));
	// Equal to Postgres's counts. A late write from an earlier test (a closing page's vitals
	// beacon) may land around the request, so a count may sit between before and after.
	const after = await counts();
	let rows = 0;
	for (const table of archive.tables) {
		expect(after.has(table.name), table.name).toBe(true);
		const [low, high] = [before.get(table.name)!, after.get(table.name)!].sort((a, b) => a - b);
		expect(table.rows.length, table.name).toBeGreaterThanOrEqual(low!);
		expect(table.rows.length, table.name).toBeLessThanOrEqual(high!);
		rows += table.rows.length;
	}
	expect(body.rows).toBe(rows);
	// The owner exists by now (the setup project), so the file holds real rows.
	expect(rows).toBeGreaterThan(0);
});
