/**
 * pnpm db:explain (Vitest project 'explain'): the backup export on M3's two-year dataset, run as
 * the cron runs it, gated well inside a 60-second Hobby function (M9 plan):
 * - export → gzip → seal into a counting sink (no buffer, so only the export's own memory
 *   shows) in BACKUP_EXPORT_BUDGET.ms or less, growing the process by BACKUP_EXPORT_BUDGET.bytes
 *   or less at its peak
 * - every exported table's cursor query: on a large relation (plan-check.ts), its primary-key
 *   index and no Seq Scan, planned as a cursor is (EXPLAIN DECLARE)
 * Resets the explain database (EXPLAIN_DATABASE_URL, default local coach_explain) and loads
 * dataset.ts first, as history.explain.ts does; the project runs the files one at a time.
 */
import { randomBytes } from 'node:crypto';
import { finished } from 'node:stream/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ArchiveWriter } from '../../src/lib/server/backup/archive';
import { sealStream } from '../../src/lib/server/backup/envelope';
import { parseBackupKey } from '../../src/lib/server/backup/key';
import { readCatalog as readBackupCatalog } from '../../src/lib/server/db/backup/catalog';
import { backupClient } from '../../src/lib/server/db/backup/connect';
import { exportDatabase } from '../../src/lib/server/db/backup/export';
import { rowsQuery } from '../../src/lib/server/db/backup/sql';
import { exportPlan } from '../../src/lib/server/db/backup/tables';
import { connectionConfig } from '../../src/lib/server/db/connection';
import { LOCAL_DATABASE_URLS, redactUrl, resetDatabase } from '../../src/lib/server/db/migrate';
import { generateDataset, loadDataset } from './dataset';
import { checkPlan, scansOf, type Catalog, type PlanNode } from './plan-check';

/** Decision (M9 plan): half of the cron function's 60 s, and 256 MB of the export's own memory. */
const BACKUP_EXPORT_BUDGET = { ms: 30_000, bytes: 256 * 1024 * 1024 } as const;

const url = process.env.EXPLAIN_DATABASE_URL || LOCAL_DATABASE_URLS.explain;
const loader = new pg.Client({ ...connectionConfig(url), application_name: 'db-explain' });
const MB = 1024 * 1024;

let catalog: Catalog;

beforeAll(async () => {
	await resetDatabase(url);
	await loader.connect();
	await loadDataset(loader, generateDataset());
	const relations = await loader.query<{ name: string; tuples: number; pages: number }>(
		`select relname as name, reltuples::float8 as tuples, relpages as pages from pg_class
		 where relnamespace = 'public'::regnamespace and relkind = 'r'`
	);
	const indexes = await loader.query<{ index: string; table: string }>(
		`select indexrelid::regclass::text as index, indrelid::regclass::text as table from pg_index
		 join pg_class on pg_class.oid = indrelid where relnamespace = 'public'::regnamespace`
	);
	catalog = {
		relations: new Map(relations.rows.map((r) => [r.name, { tuples: r.tuples, pages: r.pages }])),
		indexes: new Map(indexes.rows.map((r) => [r.index, r.table]))
	};
}, 120_000);

afterAll(async () => {
	await loader.end();
});

describe(`backup export on ${redactUrl(url)}`, () => {
	it('exports, gzips and seals the two-year dataset inside its time and memory budget', async () => {
		const key = parseBackupKey(randomBytes(32).toString('base64'), 'BACKUP_ENCRYPTION_KEY');
		const client = await backupClient(url);
		try {
			global.gc?.();
			const baseline = process.memoryUsage().rss;
			let peak = baseline;
			const sampler = setInterval(() => {
				peak = Math.max(peak, process.memoryUsage().rss);
			}, 10);
			let sealedBytes = 0;
			const writer = new ArchiveWriter();
			const sealed = writer.output.pipe(sealStream(key));
			sealed.on('data', (chunk: Buffer) => (sealedBytes += chunk.length));
			const started = performance.now();
			const { trailer } = await exportDatabase(client, writer, { appVersion: 'db-explain' });
			await finished(sealed);
			const ms = performance.now() - started;
			clearInterval(sampler);
			peak = Math.max(peak, process.memoryUsage().rss);

			const rows = Object.values(trailer.rowCounts).reduce((a, b) => a + b, 0);
			const growth = peak - baseline;
			console.log(
				`\nbackup export: ${rows} rows in ${Object.keys(trailer.rowCounts).length} tables, ` +
					`${(sealedBytes / MB).toFixed(2)} MB sealed, ${ms.toFixed(0)} ms, ` +
					`peak RSS ${(peak / MB).toFixed(0)} MB (+${(growth / MB).toFixed(0)} MB)`
			);
			expect(trailer.rowCounts.set_records).toBeGreaterThan(10_000);
			expect(ms).toBeLessThanOrEqual(BACKUP_EXPORT_BUDGET.ms);
			expect(growth).toBeLessThanOrEqual(BACKUP_EXPORT_BUDGET.bytes);
		} finally {
			await client.end();
		}
	}, 60_000);

	it("reads each large table through its primary key's index", async () => {
		await loader.query('begin isolation level repeatable read read only');
		try {
			const backup = await readBackupCatalog(loader);
			const keys = await loader.query<{ table: string; index: string }>(
				`select conrelid::regclass::text as table, conindid::regclass::text as index
				 from pg_constraint where contype = 'p' and connamespace = 'public'::regnamespace`
			);
			const pkIndex = new Map(keys.rows.map((r) => [r.table, r.index]));
			const problems: string[] = [];
			const gated: string[] = [];
			for (const table of exportPlan(backup).tables) {
				const explained = await loader.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
					`explain (format json) declare backup_plan no scroll cursor for ${rowsQuery(table)}`
				);
				const plan = explained.rows[0]!['QUERY PLAN'][0]!.Plan;
				const large = scansOf(plan, catalog).filter((s) => s.size === 'large');
				if (large.length)
					gated.push(
						`${table.name}: ${large.map((s) => `${s.node} ${s.index ?? s.relation}`).join(', ')}`
					);
				problems.push(
					...checkPlan(plan, [pkIndex.get(table.name)!], catalog).map((p) => `${table.name}: ${p}`)
				);
			}
			console.log(`\nbackup cursor plans on large relations:\n${gated.join('\n')}`);
			expect(problems).toEqual([]);
		} finally {
			await loader.query('rollback');
		}
	});
});
