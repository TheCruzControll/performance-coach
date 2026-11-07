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

	it('create the M4 sync ledger with its index and guards', async () => {
		const columns = await getDb().execute<{ column_name: string; is_nullable: string }>(
			sql`select column_name, is_nullable from information_schema.columns
				where table_schema = 'public' and table_name = 'sync_mutations' order by ordinal_position`
		);
		expect(columns.rows).toEqual([
			{ column_name: 'mutation_id', is_nullable: 'NO' },
			{ column_name: 'owner_id', is_nullable: 'NO' },
			{ column_name: 'type', is_nullable: 'NO' },
			{ column_name: 'entity_id', is_nullable: 'NO' },
			{ column_name: 'workout_client_id', is_nullable: 'YES' },
			{ column_name: 'client_at', is_nullable: 'NO' },
			{ column_name: 'applied_at', is_nullable: 'NO' },
			{ column_name: 'request_id', is_nullable: 'YES' }
		]);

		const indexes = await getDb().execute<{ indexname: string; indexdef: string }>(
			sql`select indexname, indexdef from pg_indexes where tablename = 'sync_mutations' order by 1`
		);
		expect(indexes.rows).toEqual([
			{
				indexname: 'sync_mutations_owner_workout_idx',
				indexdef: expect.stringContaining('USING btree (owner_id, workout_client_id)')
			},
			{
				indexname: 'sync_mutations_pkey',
				indexdef: expect.stringContaining('USING btree (mutation_id)')
			}
		]);

		// The type stays open: no CHECK, so a later milestone adds types without a migration.
		const checks = await getDb().execute<{ conname: string }>(
			sql`select conname from pg_constraint
				where conrelid = 'sync_mutations'::regclass and contype = 'c'`
		);
		expect(checks.rows).toEqual([]);

		const triggers = await getDb().execute<{ tgname: string }>(
			sql`select tgname from pg_trigger where not tgisinternal and tgrelid = 'sync_mutations'::regclass order by 1`
		);
		expect(triggers.rows.map((r) => r.tgname)).toEqual([
			'sync_mutations_refuse_delete',
			'sync_mutations_refuse_update'
		]);
	});

	it('create the M5 coach conversation tables with their indexes and guards', async () => {
		const tables = [
			'coach_threads',
			'coach_messages',
			'agent_runs',
			'agent_model_calls',
			'agent_tool_calls'
		];
		const names = `{${tables.join(',')}}`;
		const columns = await getDb().execute<{
			table_name: string;
			column_name: string;
			data_type: string;
		}>(
			sql`select table_name, column_name, data_type from information_schema.columns
				where table_schema = 'public' and table_name = any(${names}::text[]) order by 1, 2`
		);
		const type = (table: string, column: string) =>
			columns.rows.find((r) => r.table_name === table && r.column_name === column)?.data_type;
		// json keeps the exact text; jsonb would reorder keys.
		expect(type('coach_messages', 'content')).toBe('json');
		expect(type('coach_messages', 'display')).toBe('jsonb');
		for (const table of ['agent_runs', 'agent_model_calls']) {
			for (const column of [
				'input_tokens',
				'output_tokens',
				'cache_read_tokens',
				'cache_write_tokens',
				'cost_micros',
				'cap_cost_micros'
			]) {
				expect(type(table, column), `${table}.${column}`).toBe('bigint');
			}
		}

		const indexes = await getDb().execute<{ indexname: string; indexdef: string }>(
			sql`select indexname, indexdef from pg_indexes where tablename = any(${names}::text[])`
		);
		const index = Object.fromEntries(indexes.rows.map((r) => [r.indexname, r.indexdef]));
		expect(index.coach_threads_owner_recent_idx).toMatch(
			/\(owner_id, last_message_at DESC\) WHERE \(archived_at IS NULL\)$/
		);
		expect(index.coach_threads_owner_archived_idx).toMatch(
			/\(owner_id, archived_at DESC\) WHERE \(archived_at IS NOT NULL\)$/
		);
		expect(index.coach_messages_thread_seq_uq).toMatch(
			/^CREATE UNIQUE INDEX .*\(thread_id, seq\)$/
		);
		expect(index.coach_messages_client_message_uq).toMatch(
			/^CREATE UNIQUE INDEX .*\(client_message_id\)$/
		);
		expect(index.coach_messages_thread_segment_seq_idx).toMatch(/\(thread_id, segment, seq\)$/);
		expect(index.agent_runs_thread_running_uq).toMatch(
			/^CREATE UNIQUE INDEX .*\(thread_id\) WHERE \(status = 'running'::text\)$/
		);
		expect(index.agent_runs_owner_started_idx).toMatch(/\(owner_id, started_at DESC\)$/);
		expect(index.agent_model_calls_run_call_uq).toMatch(
			/^CREATE UNIQUE INDEX .*\(run_id, call_index\)$/
		);
		expect(index.agent_tool_calls_run_idx).toMatch(/\(run_id, call_index\)$/);

		// Row triggers only: TRUNCATE (tgtype bit 32) stays the test and reset bypass.
		const triggers = await getDb().execute<{ tgname: string; truncate: boolean }>(
			sql`select tgname, (tgtype & 32) <> 0 as truncate from pg_trigger
				where not tgisinternal and tgrelid::regclass::text = any(${names}::text[]) order by 1`
		);
		expect(triggers.rows).toEqual(
			[
				'agent_model_calls_refuse_delete',
				'agent_model_calls_refuse_update',
				'agent_runs_guard',
				'agent_runs_refuse_delete',
				'agent_tool_calls_refuse_delete',
				'agent_tool_calls_refuse_update',
				'coach_messages_refuse_delete',
				'coach_messages_refuse_update',
				'coach_threads_guard',
				'coach_threads_refuse_delete',
				'coach_threads_touch'
			].map((tgname) => ({ tgname, truncate: false }))
		);
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
