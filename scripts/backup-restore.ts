/**
 * The restore command (M9 brief, step 2): a sealed backup, from a file or the private Blob store,
 * back into an empty database, verified before the first write and timed for the restore drill.
 *
 *   BACKUP_ENCRYPTION_KEY='…' pnpm backup:restore coach.pcbk --target "$DATABASE_URL_UNPOOLED"
 *   BACKUP_ENCRYPTION_KEY='…' BLOB_READ_WRITE_TOKEN='…' \
 *     pnpm backup:restore https://<store>.private.blob.vercel-storage.com/backups/… --target "$URL"
 *
 * In order, refusing at the first problem (EXIT names each code):
 * 1. Without reading anything: the arguments; the source (scripts/backup/source.ts: a file, or
 *    https on the token's private host only); the target URL; --yes only for a localhost target;
 *    a terminal to confirm in otherwise; --force only on a scratch database (FORCE_DATABASE); the
 *    key, from BACKUP_ENCRYPTION_KEY or --key-file only.
 * 2. Download, decrypt and verify: the key id, the GCM tag, every section and the trailer's
 *    digests, then that the backup's migrations are a prefix of this checkout's journal. The
 *    backup's summary is printed; the key never is, only its id.
 * 3. Connect, print the redacted target and its state, and refuse one that holds rows (unless
 *    --force), before asking for `<database>@<host>` to be typed back.
 * 4. --force drops the drizzle and public schemas first. Then the schema step and the row step
 *    (scripts/backup/target.ts and restore.ts, one verified transaction), and the forward
 *    migration unless --no-forward-migrate.
 * 5. A markdown table of each phase's UTC start and end, for the drill record.
 *
 * A rerun of the same backup changes no row (already_restored); it still forward-migrates, so a
 * run interrupted after its commit finishes, and exits 0.
 *
 * Pass the target as "$DATABASE_URL_UNPOOLED" (the owner connection: the row step suspends user
 * triggers) and the key and token through the environment, so shell history keeps names only.
 * A connection string does not carry the Neon branch name: --force relies on the database name
 * and the typed confirmation, a recorded residual risk.
 */
import { readFile } from 'node:fs/promises';
import { stdin, stdout } from 'node:process';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { schemaTag } from '../src/lib/domain/backup/format.ts';
import { readArchive, type Archive } from '../src/lib/server/backup/archive.ts';
import { openEnvelope } from '../src/lib/server/backup/envelope.ts';
import { isBackupError } from '../src/lib/server/backup/errors.ts';
import { parseBackupKey, type BackupKey } from '../src/lib/server/backup/key.ts';
import { readCatalog } from '../src/lib/server/db/backup/catalog.ts';
import { ident } from '../src/lib/server/db/backup/sql.ts';
import { connectionConfig } from '../src/lib/server/db/connection.ts';
import {
	MIGRATIONS_SCHEMA,
	journalMigrations,
	runMigrations
} from '../src/lib/server/db/migrate.ts';
import {
	Refusal,
	confirmTyped,
	databaseTarget,
	isEntry,
	runCommand,
	variable,
	type ConfirmIo
} from './backup/cli-support.ts';
import { restoreArchive } from './backup/restore.ts';
import { parseSource, readSource, SourceError } from './backup/source.ts';
import { compareSchemas, inspectTarget, prepareTarget, type TargetState } from './backup/target.ts';

/**
 * 0 restored (or already restored); 2 refused before reading anything (arguments, environment,
 * confirmation); 3 the backup refused (download, decryption, verification, or a migration
 * history this checkout cannot rebuild); 4 the target refused (unreachable, holding rows, or at
 * another schema), nothing written; 5 the restore failed after it began: rolled back, or the
 * forward migration failed after the rows committed.
 */
export const EXIT = { ok: 0, refused: 2, backup: 3, target: 4, failed: 5 } as const;

/**
 * The databases --force may reset (owner decision, M9 open question 'The --force scratch
 * rule'): a scratch_, restore_ or drill_ prefix, or a _test suffix, and never NEVER_FORCED.
 */
export const FORCE_DATABASE = /^(?:(?:scratch|restore|drill)_[a-z0-9_]{1,40}|[a-z0-9_]+_test)$/;
export const NEVER_FORCED = ['neondb', 'postgres'];

/** The hosts --yes may skip the typed confirmation for. */
export const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export function forceAllowed(database: string): boolean {
	return !NEVER_FORCED.includes(database) && FORCE_DATABASE.test(database);
}

const USAGE = `Usage: BACKUP_ENCRYPTION_KEY=… pnpm backup:restore <file | https-url> --target <url> [options]

  <https-url>             a backup in the private Blob store (needs BLOB_READ_WRITE_TOKEN)
  --target <url>          the database to restore into, empty: pass "$DATABASE_URL_UNPOOLED"
  --key-file <file>       read the key from a file instead of BACKUP_ENCRYPTION_KEY
  --yes                   skip typing <database>@<host> (a localhost target only)
  --force                 reset a scratch database first (scratch_*, restore_*, drill_*, *_test)
  --no-forward-migrate    stop at the backup's schema instead of migrating to this checkout's
  --label <text>          a caption for the timing table, such as the drill's date`;

const OPTIONS = {
	target: { type: 'string' },
	'key-file': { type: 'string' },
	yes: { type: 'boolean' },
	force: { type: 'boolean' },
	'no-forward-migrate': { type: 'boolean' },
	label: { type: 'string' },
	help: { type: 'boolean' }
} as const;

function parse(argv: string[]) {
	try {
		return parseArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: true });
	} catch (error) {
		throw new Refusal(`${(error as Error).message}\n\n${USAGE}`);
	}
}

async function readKey(file: string | undefined, env: Record<string, string | undefined>) {
	const fromEnv = variable(env, 'BACKUP_ENCRYPTION_KEY');
	if (file !== undefined && fromEnv) {
		throw new Refusal('Refusing to run: choose one key, BACKUP_ENCRYPTION_KEY or --key-file.');
	}
	if (file === undefined && !fromEnv) {
		throw new Refusal(
			`Refusing to run: set BACKUP_ENCRYPTION_KEY or pass --key-file <file>.\n\n${USAGE}`
		);
	}
	let text = fromEnv;
	if (file !== undefined) {
		try {
			text = await readFile(file, 'utf8');
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? 'error';
			throw new Refusal(`Refusing to run: cannot read --key-file ${file} (${code}).`);
		}
	}
	try {
		return parseBackupKey(text!, file === undefined ? 'BACKUP_ENCRYPTION_KEY' : '--key-file');
	} catch (error) {
		if (!isBackupError(error)) throw error;
		throw new Refusal(`Refusing to run: ${error.message}.`);
	}
}

interface Phase {
	name: string;
	start: Date;
	end: Date;
}

async function timed<T>(phases: Phase[], name: string, run: () => T | Promise<T>): Promise<T> {
	const start = new Date();
	const result = await run();
	phases.push({ name, start, end: new Date() });
	return result;
}

const PHASES = [
	'download',
	'decrypt and verify',
	'schema',
	'rows and digests',
	'forward migration'
];

/** Each phase's UTC start, end and seconds as a markdown table, skipped ones marked. */
export function timingTable(phases: Phase[], label: string | undefined): string {
	const row = (name: string, start: Date, end: Date) =>
		`| ${name} | ${start.toISOString()} | ${end.toISOString()} | ${((end.getTime() - start.getTime()) / 1000).toFixed(2)} |`;
	const lines = PHASES.map((name) => {
		const phase = phases.find((p) => p.name === name);
		return phase ? row(name, phase.start, phase.end) : `| ${name} | skipped | | |`;
	});
	return [
		`Restore timings (UTC)${label ? `: ${label}` : ''}`,
		'',
		'| Phase | Started (UTC) | Finished (UTC) | Seconds |',
		'| --- | --- | --- | --- |',
		...lines,
		row('total', phases[0]!.start, phases.at(-1)!.end)
	].join('\n');
}

function describeState(target: TargetState): string {
	if (target.state === 'blank') return 'blank (no schema)';
	const some = target.tables.slice(0, 3).join(', ');
	const more = target.tables.length > 3 ? ` and ${target.tables.length - 3} more tables` : '';
	const rows = target.empty ? 'empty' : `rows in ${some}${more}`;
	const restored =
		target.state === 'restored' ? `, restored ${target.restores.length} time(s)` : '';
	return `migrated (${target.migrations.length} migrations${restored}), ${rows}`;
}

/** The tables that make the target unusable without --force, or null when it may be used. */
function occupiedBy(target: TargetState, sha256: string): string[] | null {
	if (target.state === 'blank') return null;
	if (target.state === 'restored') {
		return target.restores.some((r) => r.sha256 === sha256) ? null : target.tables;
	}
	return target.empty ? null : target.tables;
}

export interface RestoreDeps {
	fetch?: typeof globalThis.fetch;
	io?: ConfirmIo;
}

export async function main(
	argv: string[],
	env: Record<string, string | undefined>,
	{ fetch = globalThis.fetch, io = { input: stdin, output: stdout } }: RestoreDeps = {}
): Promise<number> {
	const { values: flags, positionals } = parse(argv);
	if (flags.help) {
		console.log(USAGE);
		return EXIT.ok;
	}
	if (positionals.length !== 1) {
		throw new Refusal(`Name exactly one backup, a file or a Blob URL.\n\n${USAGE}`);
	}
	if (!flags.target) throw new Refusal(`Name the database with --target <url>.\n\n${USAGE}`);
	const url = flags.target;
	const source = parseSource(positionals[0]!, variable(env, 'BLOB_READ_WRITE_TOKEN'));
	const target = databaseTarget(url, '--target');
	if (flags.yes && !LOCAL_HOSTS.includes(target.host)) {
		throw new Refusal(
			`Refusing --yes for ${target.host}: it works for a localhost target only. Type the confirmation in a terminal.`
		);
	}
	if (!flags.yes && !io.input.isTTY) {
		throw new Refusal(
			'Refusing to run non-interactively: type the confirmation in a terminal (--yes works for a localhost target only).'
		);
	}
	if (flags.force && !forceAllowed(target.name)) {
		throw new Refusal(
			`Refusing --force on ${target.name}: only a scratch database (scratch_*, restore_*, drill_* or *_test) may be reset.`
		);
	}
	const key: BackupKey = await readKey(flags['key-file'], env);

	const phases: Phase[] = [];
	let archive: Archive;
	let bytes: number;
	try {
		const sealed = await timed(phases, 'download', () => readSource(source, { fetch }));
		bytes = sealed.length;
		archive = await timed(phases, 'decrypt and verify', () =>
			readArchive(openEnvelope(key, sealed))
		);
	} catch (error) {
		if (!(error instanceof SourceError) && !isBackupError(error)) throw error;
		console.error(`Backup refused (${error.code}): ${error.message}. Nothing was written.`);
		return EXIT.backup;
	}
	const { header, trailer } = archive;
	const journal = await journalMigrations();
	const rows = Object.values(trailer.rowCounts).reduce((sum, n) => sum + n, 0);
	console.log(
		[
			`Backup:   ${source.kind === 'file' ? source.path : source.url}`,
			`Taken:    ${header.createdAt} (app ${header.appVersion}), ${bytes} bytes`,
			`Schema:   ${schemaTag(header)} (this checkout has ${journal.length} migrations)`,
			`Rows:     ${rows} in ${header.tables.length} tables, sha256 ${trailer.sha256}`,
			`Key id:   ${key.id}`
		].join('\n')
	);
	const fits = compareSchemas(header.schema.migrations, journal);
	if (!fits.ok) {
		console.error(
			fits.code === 'history_diverged'
				? `Backup refused (history_diverged): its migration ${fits.at + 1} is not this checkout's ${fits.tag}.`
				: `Backup refused (backup_newer_than_checkout): it ran ${fits.backup} migrations; this checkout has ${fits.checkout}.`
		);
		return EXIT.backup;
	}

	const client = new pg.Client({
		...connectionConfig(url),
		application_name: 'coach-restore',
		connectionTimeoutMillis: 10_000
	});
	console.log(`Target:   ${target.redacted}`);
	try {
		await client.connect();
	} catch (error) {
		const code = (error as { code?: string }).code ?? (error as Error).name;
		console.error(`Target refused (unreachable): cannot connect (${code}).`);
		return EXIT.target;
	}
	try {
		return await restore();
	} catch (error) {
		const code = (error as { code?: string }).code ?? (error as Error).name;
		console.error(`Restore failed (${code}): ${(error as Error).message}`);
		return EXIT.failed;
	} finally {
		await client.end();
	}

	async function restore(): Promise<number> {
		const state = await inspectTarget(client);
		console.log(`State:    ${describeState(state)}`);
		const occupied = flags.force ? null : occupiedBy(state, trailer.sha256);
		if (occupied) {
			console.error(
				`Target refused (target_not_empty): rows in ${occupied.join(', ') || 'a restored database'}. ` +
					'Restore into an empty database, or reset a scratch one with --force. Nothing was written.'
			);
			return EXIT.target;
		}
		const answer = flags.yes ? 'confirmed' : await confirmTyped(target.confirmation, io);
		if (answer !== 'confirmed') {
			console.error('Confirmation did not match. Nothing was written.');
			return EXIT.refused;
		}

		const prepared = await timed(phases, 'schema', async () => {
			if (flags.force && state.state !== 'blank') {
				await client.query(
					`DROP SCHEMA IF EXISTS ${ident(MIGRATIONS_SCHEMA)} CASCADE;
					DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public`
				);
			}
			return prepareTarget(
				url,
				client,
				{ schema: header.schema, sha256: trailer.sha256 },
				{ journal }
			);
		});
		let done: string;
		if (!prepared.ok && prepared.code === 'already_restored') {
			done = `Already restored at ${prepared.restoredAt.toISOString()}: no row was written.`;
		} else if (!prepared.ok) {
			const why =
				prepared.code === 'target_not_empty'
					? `rows in ${prepared.tables.join(', ')}`
					: prepared.code === 'target_schema_mismatch'
						? `it is at ${prepared.target} migrations, the backup at ${prepared.backup}; use a blank database`
						: 'its migration history does not fit this checkout';
			console.error(`Target refused (${prepared.code}): ${why}. Nothing was written.`);
			return EXIT.target;
		} else {
			const loaded = await timed(phases, 'rows and digests', async () =>
				restoreArchive(client, archive, await readCatalog(client))
			);
			if (!loaded.ok && loaded.code === 'manifest_mismatch') {
				console.error(`Target refused (manifest_mismatch): ${loaded.names.join(', ')}.`);
				return EXIT.target;
			}
			if (!loaded.ok && loaded.code === 'digest_mismatch') {
				console.error(
					`Restore failed (digest_mismatch): ${loaded.tables.join(', ')}. Everything was rolled back.`
				);
				return EXIT.failed;
			}
			done = loaded.ok
				? `Restored: ${rows} rows in ${header.tables.length} tables, ${loaded.sequences} sequences, every digest verified (from a ${prepared.from} target).`
				: `Already restored at ${loaded.restoredAt.toISOString()}: no row was written.`;
		}
		console.log(done);
		if (!flags['no-forward-migrate']) {
			const forward = await timed(phases, 'forward migration', () => runMigrations(url));
			console.log(`Migrated: ${forward.applied} applied, ${forward.total} in total.`);
		}
		console.log(`\n${timingTable(phases, flags.label)}`);
		return EXIT.ok;
	}
}

if (isEntry(import.meta.url)) await runCommand(() => main(process.argv.slice(2), process.env));
