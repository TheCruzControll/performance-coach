/**
 * What making more than one owner world takes (e2e/worlds.ts): a database per world, a build per
 * origin, and copying the world the owner setup ran in into the others.
 *
 * Admin work (creating a database, copying rows past their triggers and foreign keys) connects
 * as PGADMIN_URL, the superuser `pnpm db:setup` uses (CI sets it), or else as E2E_DATABASE_URL's
 * own role; the specs and the servers keep connecting as E2E_DATABASE_URL's role.
 */
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { connectionConfig } from '../src/lib/server/db/connection';
import { databaseName } from '../src/lib/server/db/migrate';
import { onDatabase, world, worldCount, worlds, type World } from './worlds';
import type { E2EEnv } from './projects';

/** The admin connection to database `name`: PGADMIN_URL's server and role, else `url`'s. */
export function adminUrl(env: E2EEnv, url: string, name = databaseName(url)): string {
	return onDatabase(env.PGADMIN_URL || url, name);
}

async function withClient<T>(url: string, run: (client: pg.Client) => Promise<T>): Promise<T> {
	const client = new pg.Client(connectionConfig(url));
	await client.connect();
	try {
		return await run(client);
	} finally {
		await client.end();
	}
}

const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Creates `url`'s database, owned by `url`'s role, unless it exists. */
export async function ensureDatabase(env: E2EEnv, url: string): Promise<void> {
	const name = databaseName(url);
	const owner = decodeURIComponent(new URL(url).username);
	await withClient(adminUrl(env, url, 'postgres'), async (admin) => {
		const { rowCount } = await admin.query('select 1 from pg_database where datname = $1', [name]);
		if (rowCount) return;
		await admin.query(`create database ${ident(name)}${owner ? ` owner ${ident(owner)}` : ''}`);
	});
}

/** Whether `url`'s database holds the owner (the `setup` project creates it). */
async function holdsOwner(url: string): Promise<boolean> {
	return withClient(url, async (client) => {
		const { rows } = await client.query<{ found: boolean }>(
			'select exists (select 1 from owners) as found'
		);
		return rows[0]?.found === true;
	});
}

/**
 * The world the owner setup ran in: the first world whose database holds the owner (before
 * setup-worlds copies it, the only one). With one world, world 0, unasked.
 */
export async function ownerWorld(env: E2EEnv): Promise<World> {
	if (worldCount(env) === 1) return world(0, env);
	for (const candidate of worlds(env)) {
		if (await holdsOwner(candidate.databaseUrl)) return candidate;
	}
	throw new Error('[e2e] no world holds the owner: the setup project creates it');
}

interface TableInfo {
	name: string;
	/** Its columns in order, generated ones left out (they are computed again on insert). */
	columns: string[];
}

/** The public schema's tables (partitions through their parent) and their insertable columns. */
const TABLES = `
	select c.relname::text as name,
		array_agg(a.attname::text order by a.attnum) filter (where a.attgenerated = '') as columns
	from pg_class c
	join pg_namespace n on n.oid = c.relnamespace
	join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
	where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relispartition
	group by c.relname
	order by c.relname`;

/** Each table's rows as one digest, one query at a time: equal digests, equal rows. */
async function digests(client: pg.Client, tables: readonly TableInfo[]): Promise<string[]> {
	const out: string[] = [];
	for (const { name } of tables) {
		const { rows } = await client.query<{ digest: string | null }>(
			`select md5(string_agg(world_row::text, ',' order by world_row::text)) as digest
			from public.${ident(name)} world_row`
		);
		out.push(`${name}:${rows[0]?.digest ?? 'empty'}`);
	}
	return out;
}

/**
 * Replaces every row of `to`'s public schema with `from`'s, in one transaction, and sets its
 * sequences where `from`'s are; then checks every table's rows match. Both databases have the
 * same migrations (global setup resets each). Rows travel as JSON, which keeps every type this
 * schema uses exactly (timestamps to the microsecond, numerics digit for digit, bytea as hex).
 * The target connection is the admin's, with session_replication_role = replica, so foreign keys
 * and triggers (the program tables refuse updates and deletes) stay out of a copy.
 */
export async function copyDatabase(env: E2EEnv, from: string, to: string): Promise<void> {
	await withClient(from, (source) =>
		withClient(adminUrl(env, to), async (target) => {
			await source.query('begin isolation level repeatable read read only');
			const tables = (await source.query<TableInfo>(TABLES)).rows;
			const targetTables = (await target.query<TableInfo>(TABLES)).rows;
			if (JSON.stringify(targetTables) !== JSON.stringify(tables)) {
				throw new Error(`[e2e] ${databaseName(to)} has other tables than ${databaseName(from)}`);
			}
			const rows = new Map<string, string>();
			for (const { name } of tables) {
				const { rows: result } = await source.query<{ rows: string }>(
					`select coalesce(json_agg(row_to_json(world_row)), '[]')::text as rows
					from public.${ident(name)} world_row`
				);
				rows.set(name, result[0]!.rows);
			}
			const { rows: sequences } = await source.query<{
				name: string;
				last: string | null;
				start: string;
			}>(
				`select format('public.%I', sequencename) as name, last_value::text as last,
					start_value::text as start
				from pg_sequences where schemaname = 'public'`
			);
			const expected = await digests(source, tables);
			await source.query('commit');

			await target.query('begin');
			try {
				await target.query('set local session_replication_role = replica');
				if (tables.length > 0) {
					await target.query(
						`truncate ${tables.map(({ name }) => `public.${ident(name)}`).join(', ')}`
					);
				}
				for (const { name, columns } of tables) {
					const json = rows.get(name)!;
					if (json === '[]') continue;
					const list = columns.map(ident).join(', ');
					await target.query(
						`insert into public.${ident(name)} (${list}) overriding system value
						select ${list} from json_populate_recordset(null::public.${ident(name)}, $1::json)`,
						[json]
					);
				}
				for (const { name, last, start } of sequences) {
					await target.query('select setval($1::regclass, $2::bigint, $3)', [
						name,
						last ?? start,
						last !== null
					]);
				}
				await target.query('commit');
			} catch (error) {
				await target.query('rollback').catch(() => {});
				throw error;
			}
			const copied = await digests(target, tables);
			const differ = copied.filter((entry, i) => entry !== expected[i]);
			if (differ.length > 0) {
				throw new Error(`[e2e] the copy of ${databaseName(from)} differs in ${differ.join(', ')}`);
			}
		})
	);
}

/** Every file under `dir`, recursively. */
function filesIn(dir: string): string[] {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => path.join(entry.parentPath, entry.name));
}

/** Files a build may bake its origin into as text. */
const TEXT = /\.(?:m?js|json|html|css|txt|map|webmanifest|xml|svg)$/;

/**
 * `to`: a copy of the adapter-node build in `from`, made for `toOrigin`. adapter-node bakes its
 * origin (vite.config.ts paths.origin) into the server code, the CSRF check's included, so a
 * server for another port needs its own copy; the origin is replaced wherever it appears, and
 * the build must have been made for `fromOrigin`. A file that bakes it in but is also served
 * precompressed (its .br or .gz would keep the old origin), or is not text, fails the copy.
 */
export function deriveBuild(from: string, to: string, fromOrigin: string, toOrigin: string): void {
	const marker = `export const origin = ${JSON.stringify(fromOrigin)};`;
	const entry = path.join(from, 'adapter-node.js');
	if (!existsSync(entry) || !readFileSync(entry, 'utf8').includes(marker)) {
		throw new Error(`[e2e] ${from} is not an adapter-node build for ${fromOrigin}`);
	}
	rmSync(to, { recursive: true, force: true });
	cpSync(from, to, { recursive: true });
	const pattern = new RegExp(`${fromOrigin.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(?![\\d])`, 'g');
	const needle = Buffer.from(fromOrigin);
	let rewritten = 0;
	for (const file of filesIn(to)) {
		if (/\.(?:br|gz)$/.test(file)) continue;
		const bytes = readFileSync(file);
		if (!bytes.includes(needle)) continue;
		if (!TEXT.test(file) || existsSync(`${file}.br`) || existsSync(`${file}.gz`)) {
			throw new Error(`[e2e] ${file} bakes ${fromOrigin} in where it cannot be replaced`);
		}
		writeFileSync(file, bytes.toString('utf8').replace(pattern, toOrigin));
		rewritten++;
	}
	if (!readFileSync(path.join(to, 'adapter-node.js'), 'utf8').includes(toOrigin) || !rewritten) {
		throw new Error(`[e2e] ${to} does not serve ${toOrigin}`);
	}
}
