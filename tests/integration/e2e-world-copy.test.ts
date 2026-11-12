/**
 * e2e/world-copy.ts copyDatabase, which gives every worker of a serial e2e leg the owner world
 * the setup made (e2e/worlds.ts): from the backup tests' scratch source (an owner, a profile, a
 * program behind its refuse-update triggers, history, and the edge, cycle and bulk tables) into
 * the scratch destination, it replaces every row, keeps every id and moves every sequence, and
 * it refuses a destination with other tables before writing anything.
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectionConfig } from '../../src/lib/server/db/connection';
import { resetDatabase } from '../../src/lib/server/db/migrate';
import { copyDatabase } from '../../e2e/world-copy';
import { EDGE_DDL, prepareSource, scratchUrl } from './backup/scratch';

const SLOW = 60_000;
const env = { PGADMIN_URL: process.env.PGADMIN_URL };
const dstUrl = scratchUrl('dst');
let srcUrl: string;
let src: pg.Client;
let dst: pg.Client;

async function connect(url: string): Promise<pg.Client> {
	const client = new pg.Client(connectionConfig(url));
	await client.connect();
	return client;
}

/** Every public table's rows, as sorted text, by table. */
async function contents(client: pg.Client): Promise<Record<string, string[]>> {
	const { rows: tables } = await client.query<{ name: string }>(
		`select tablename as name from pg_tables where schemaname = 'public' order by tablename`
	);
	const out: Record<string, string[]> = {};
	for (const { name } of tables) {
		const { rows } = await client.query<{ row: string }>(
			`select t::text as row from public."${name}" t order by 1`
		);
		out[name] = rows.map((r) => r.row);
	}
	return out;
}

beforeAll(async () => {
	({ url: srcUrl } = await prepareSource());
	await resetDatabase(dstUrl);
	src = await connect(srcUrl);
	dst = await connect(dstUrl);
	await dst.query(EDGE_DDL);
}, SLOW);

afterAll(async () => {
	await src?.end();
	await dst?.end();
});

describe('copyDatabase', () => {
	it(
		'replaces every row, id and sequence of a database with the same migrations',
		async () => {
			// A stale row the copy must not keep.
			await dst.query(`insert into backup_bulk values (999999, 'stale')`);
			await copyDatabase(env, srcUrl, dstUrl);

			const copied = await contents(dst);
			expect(copied).toEqual(await contents(src));
			expect(copied.owners).toHaveLength(1);
			expect(copied.programs!.length).toBeGreaterThan(0);
			expect(copied.backup_bulk).not.toContain('(999999,stale)');

			// The sequences continue where the source's do.
			const next = async (client: pg.Client) =>
				(await client.query<{ id: string }>(`select nextval('auth_events_id_seq')::text as id`))
					.rows[0]!.id;
			expect(await next(dst)).toBe(await next(src));
		},
		SLOW
	);

	it(
		'refuses a database whose tables differ, and changes nothing in it',
		async () => {
			await dst.query('create table world_copy_extra (id int primary key)');
			try {
				const before = await contents(dst);
				await expect(copyDatabase(env, srcUrl, dstUrl)).rejects.toThrow(/other tables/);
				expect(await contents(dst)).toEqual(before);
			} finally {
				await dst.query('drop table world_copy_extra');
			}
		},
		SLOW
	);
});
