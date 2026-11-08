/**
 * A backup taken by hand (M9): the same verified run as the daily cron, into a local file or into
 * the private Blob store.
 *
 *   DATABASE_URL_UNPOOLED='postgres://…' BACKUP_ENCRYPTION_KEY='…' pnpm backup:run --out coach.pcbk
 *   DATABASE_URL_UNPOOLED='postgres://…' BACKUP_ENCRYPTION_KEY='…' BLOB_READ_WRITE_TOKEN='…' \
 *     pnpm backup:run --blob
 *
 * Guard rails, as auth:reset-owner's: the database is only ever the one SOURCE_VARIABLE names
 * (no DATABASE_URL, no local default, and `pnpm backup:run` loads no .env file), its redacted URL
 * is printed before anything connects, and every refusal comes before any connection. --blob
 * writes into the store the cron prunes, where a backup of the wrong database would become that
 * day's kept backup, so it asks for `<database>@<host>` to be typed back in a terminal.
 * Pass the URL, the key and the token through the environment of one command, never as
 * arguments, so shell history and the process list do not keep them.
 *
 * --out runs the backup into a private temporary folder store (read back and verified there),
 * then copies the file to <file>, refusing an existing one.
 */
import { randomUUID } from 'node:crypto';
import { constants, existsSync, readFileSync } from 'node:fs';
import { copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { privateHost } from '../src/lib/server/backup/blob-store.ts';
import { backupConfig } from '../src/lib/server/backup/config.ts';
import { logger, setLogLevel } from '../src/lib/server/observability/logger.ts';
import {
	isBackupRunError,
	runBackup,
	type BackupRunEnv,
	type BackupRunResult
} from '../src/lib/server/services/backups/index.ts';
import {
	EXIT,
	Refusal,
	confirmTyped,
	databaseTarget,
	isEntry,
	parseCommand,
	runCommand,
	variable
} from './backup/cli-support.ts';

/** The only variable the database is read from: the direct connection, as for migrations. */
export const SOURCE_VARIABLE = 'DATABASE_URL_UNPOOLED';

const USAGE = `Usage: ${SOURCE_VARIABLE}=… BACKUP_ENCRYPTION_KEY=… pnpm backup:run (--out <file> | --blob)

  --out <file>  write the sealed backup to a new local file
  --blob        upload it to the private Blob store (needs BLOB_READ_WRITE_TOKEN, from the
                store's page) and prune it, after typing <database>@<host> to confirm`;

function appVersion(): string {
	const pkg = new URL('../package.json', import.meta.url);
	return (JSON.parse(readFileSync(pkg, 'utf8')) as { version: string }).version;
}

export async function main(
	argv: string[],
	env: Record<string, string | undefined>
): Promise<number> {
	const flags = parseCommand(
		argv,
		{ out: { type: 'string' }, blob: { type: 'boolean' }, help: { type: 'boolean' } },
		USAGE
	);
	if (!flags) return EXIT.ok;
	if ((flags.out === undefined) === !flags.blob) {
		throw new Refusal(`Choose exactly one of --out <file> and --blob.\n\n${USAGE}`);
	}
	const url = variable(env, SOURCE_VARIABLE);
	if (!url) {
		throw new Refusal(
			`Refusing to run: set ${SOURCE_VARIABLE} to the connection string of the database to back\n` +
				'up (Neon → production branch → direct connection). There is no default.'
		);
	}
	const target = databaseTarget(url, SOURCE_VARIABLE);
	const out = flags.out === undefined ? null : path.resolve(flags.out);
	if (out !== null && existsSync(out)) throw new Refusal(`Refusing to overwrite ${out}.`);

	// --out stages in a fresh folder of its own; --blob can only ever reach the Blob store.
	const staging = path.join(tmpdir(), `coach-backup-${randomUUID()}`);
	const runEnv: BackupRunEnv = {
		DATABASE_URL: url,
		BACKUP_ENCRYPTION_KEY: variable(env, 'BACKUP_ENCRYPTION_KEY'),
		...(out === null
			? { BLOB_READ_WRITE_TOKEN: variable(env, 'BLOB_READ_WRITE_TOKEN') }
			: { BACKUP_DIR: staging })
	};
	const config = backupConfig(runEnv);
	if (config.state === 'off') {
		const problems = [
			...config.missing.map((name) => `set ${name}`),
			...config.invalid.map((name) => `${name} is not valid`)
		];
		throw new Refusal(`Refusing to run: ${problems.join('; ')}.\n\n${USAGE}`);
	}

	console.log(`Database: ${target.redacted}`);
	console.log(
		`Into:     ${config.store.kind === 'blob' ? `Vercel Blob ${privateHost(config.store.token)}` : out}`
	);
	console.log(`Key id:   ${config.key.id}`);
	if (out === null) {
		const answer = await confirmTyped(target.confirmation);
		if (answer === 'not_interactive') {
			throw new Refusal('Refusing to run non-interactively: type the confirmation in a terminal.');
		}
		if (answer === 'mismatch') {
			console.error('Confirmation did not match. Nothing was backed up.');
			return EXIT.failed;
		}
	}

	if (!env.LOG_LEVEL) setLogLevel('warn');
	let result: BackupRunResult;
	try {
		result = await runBackup(
			{ now: new Date(), trigger: 'manual', env: runEnv, appVersion: appVersion() },
			{
				// The app records into app_errors; an operator sees the failure here instead.
				record: async ({ error, context }) =>
					logger.error('backup run failed', { code: context?.code, err: error })
			}
		);
		if (out !== null)
			await copyFile(path.join(staging, result.pathname), out, constants.COPYFILE_EXCL);
	} catch (error) {
		if (!isBackupRunError(error)) throw error;
		console.error(`Backup failed (${error.code}): ${error.message}`);
		return EXIT.failed;
	} finally {
		await rm(staging, { recursive: true, force: true });
	}

	const { phases, pruned } = result;
	console.log(
		[
			`Backup:   ${out ?? result.pathname}`,
			`Size:     ${result.bytes} bytes, sha256 ${result.sha256}`,
			`Rows:     ${result.rows} in ${result.tables} tables`,
			`Time:     ${result.durationMs} ms (export ${phases.export}, upload ${phases.upload}, read-back ${phases.readBack}, prune ${phases.prune})`,
			...(out === null
				? [
						pruned
							? `Pruned:   ${pruned.deleted.length} deleted, ${pruned.kept.length} kept`
							: 'Pruned:   failed (see the log above); the backup itself is made'
					]
				: [])
		].join('\n')
	);
	return EXIT.ok;
}

if (isEntry(import.meta.url)) await runCommand(() => main(process.argv.slice(2), process.env));
