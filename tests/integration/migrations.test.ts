import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getDb } from '../../src/lib/server/db';
import { withRollback } from './helpers';

const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as {
	entries: { tag: string }[];
};

describe('committed migrations', () => {
	it('are all applied to the test database', async () => {
		const result = await getDb().execute<{ n: number }>(
			sql`select count(*)::int as n from drizzle.__drizzle_migrations`
		);
		expect(journal.entries.length).toBeGreaterThan(0);
		expect(result.rows[0]?.n).toBe(journal.entries.length);
	});

	it('create the M1 tables with their indexes', async () => {
		const tables = await getDb().execute<{ table_name: string }>(
			sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`
		);
		expect(tables.rows.map((r) => r.table_name)).toEqual(
			expect.arrayContaining(['app_errors', 'web_vitals'])
		);
		const indexes = await getDb().execute<{ indexname: string }>(
			sql`select indexname from pg_indexes where tablename = 'web_vitals'`
		);
		expect(indexes.rows.map((r) => r.indexname)).toEqual(
			expect.arrayContaining([
				'web_vitals_metric_uq',
				'web_vitals_name_recorded_at_idx',
				'web_vitals_route_name_idx'
			])
		);
	});

	it('create the M3 program tables with their indexes and history guards', async () => {
		const programTables = [
			'programs',
			'program_versions',
			'program_blocks',
			'program_version_blocks',
			'program_weeks',
			'program_version_weeks',
			'planned_sessions',
			'programming_decisions'
		];
		const tables = await getDb().execute<{ table_name: string }>(
			sql`select table_name from information_schema.tables where table_schema = 'public'`
		);
		expect(tables.rows.map((r) => r.table_name)).toEqual(expect.arrayContaining(programTables));

		const indexes = await getDb().execute<{ indexname: string }>(
			sql`select indexname from pg_indexes where schemaname = 'public'`
		);
		expect(indexes.rows.map((r) => r.indexname)).toEqual(
			expect.arrayContaining([
				'programs_owner_active_uq',
				'program_versions_program_number_uq',
				'program_version_blocks_pk',
				'program_version_weeks_pk',
				'program_version_weeks_week_idx',
				'planned_sessions_week_day_idx',
				'planned_sessions_lineage_idx',
				'programming_decisions_program_idx',
				'programming_decisions_version_idx'
			])
		);

		const triggers = await getDb().execute<{ tgname: string }>(
			sql`select tgname from pg_trigger where not tgisinternal`
		);
		expect(triggers.rows.map((r) => r.tgname)).toEqual(
			expect.arrayContaining([
				'programs_head_guard',
				...programTables.map((t) => `${t}_refuse_delete`),
				...programTables.filter((t) => t !== 'programs').map((t) => `${t}_refuse_update`)
			])
		);
	});

	it('create the email sign-in links table with its indexes and constraints', async () => {
		const indexes = await getDb().execute<{ indexname: string; indexdef: string }>(
			sql`select indexname, indexdef from pg_indexes where tablename = 'email_sign_in_links'`
		);
		const index = Object.fromEntries(indexes.rows.map((r) => [r.indexname, r.indexdef]));
		expect(Object.keys(index).sort()).toEqual([
			'email_sign_in_links_expires_idx',
			'email_sign_in_links_owner_live_idx',
			'email_sign_in_links_pkey',
			'email_sign_in_links_token_hash_uq'
		]);
		expect(index.email_sign_in_links_token_hash_uq).toMatch(/^CREATE UNIQUE INDEX/);
		expect(index.email_sign_in_links_owner_live_idx).toMatch(
			/\(owner_id\) WHERE \(\(used_at IS NULL\) AND \(revoked_at IS NULL\)\)$/
		);

		// PostgreSQL 18 also lists NOT NULL constraints (contype 'n'); 16 does not.
		const constraints = await getDb().execute<{ conname: string; contype: string; def: string }>(
			sql`select conname, contype, pg_get_constraintdef(oid) as def from pg_constraint
				where conrelid = 'email_sign_in_links'::regclass and contype <> 'n' order by conname`
		);
		expect(constraints.rows.map((r) => [r.conname, r.contype])).toEqual([
			['email_sign_in_links_lifetime_ck', 'c'],
			['email_sign_in_links_owner_id_owners_id_fk', 'f'],
			['email_sign_in_links_pkey', 'p'],
			['email_sign_in_links_session_ck', 'c'],
			['email_sign_in_links_session_id_auth_sessions_id_fk', 'f'],
			['email_sign_in_links_state_ck', 'c'],
			['email_sign_in_links_token_hash_ck', 'c']
		]);
		const def = Object.fromEntries(constraints.rows.map((r) => [r.conname, r.def]));
		expect(def.email_sign_in_links_lifetime_ck).toContain("'00:15:00'::interval");
		expect(def.email_sign_in_links_owner_id_owners_id_fk).toContain('ON DELETE CASCADE');
		expect(def.email_sign_in_links_session_id_auth_sessions_id_fk).toContain('ON DELETE SET NULL');
	});

	it('enforce check constraints at the database level', async () => {
		const error = await withRollback((tx) =>
			tx.execute(
				sql`insert into web_vitals (metric_id, name, value, rating, path) values ('x', 'FID', 1, 'good', '/')`
			)
		).catch((err: unknown) => err);
		// Drizzle wraps the driver error; the Postgres error is the cause.
		expect((error as { cause?: { constraint?: string } }).cause?.constraint).toBe(
			'web_vitals_name_ck'
		);
	});
});
