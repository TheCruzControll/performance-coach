/**
 * The backup operator tools (backup:run, backup:restore, backup:keygen) import
 * src/lib/server/backup under plain Node, with type stripping and no Vite. So every runtime import
 * there needs an explicit .ts specifier and type-only syntax only. This seals and reopens a real
 * archive in a plain Node child process, so a module that only Vite can load fails here and not
 * in an operator's terminal.
 */
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const rootUrl = pathToFileURL(realpathSync(root) + path.sep).href;
const backup = (file: string) => JSON.stringify(path.join(root, 'src/lib/server/backup', file));

/** Runs `body` as an ES module in plain Node; it sees `loaded`, the src/ files Node resolved. */
function plainNode(body: string) {
	const script = [
		`import { registerHooks } from 'node:module';`,
		`const resolved = [];`,
		`registerHooks({ resolve: (specifier, context, next) => { const r = next(specifier, context); resolved.push(r.url); return r; } });`,
		`const loadedFiles = () => [...new Set(resolved)].filter((url) => url.startsWith(${JSON.stringify(`${rootUrl}src/`)})).map((url) => url.slice(${rootUrl.length}));`,
		body
	].join('\n');
	return spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
		cwd: root,
		encoding: 'utf8',
		timeout: 30_000
	});
}

describe('src/lib/server/backup under plain Node', () => {
	it('seals an archive and opens it again with type stripping alone', () => {
		const result = plainNode(`
			const { parseBackupKey } = await import(${backup('key.ts')});
			const { sealStream, openEnvelope } = await import(${backup('envelope.ts')});
			const { ArchiveWriter, readArchive } = await import(${backup('archive.ts')});
			const { isBackupError } = await import(${backup('errors.ts')});
			const { buffer } = await import('node:stream/consumers');

			const key = parseBackupKey(Buffer.alloc(32, 3).toString('base64'), 'BACKUP_ENCRYPTION_KEY');
			const writer = new ArchiveWriter();
			const sealed = buffer(writer.output.pipe(sealStream(key)));
			const hash = 'a'.repeat(64);
			writer.header({
				kind: 'header', format: 'performance-coach-backup', formatVersion: 1,
				createdAt: '2026-11-07T10:41:00.000Z', appVersion: '0.1.0',
				schema: { migrations: [{ hash, createdAt: 1 }], count: 1, lastHash: hash },
				settings: { TimeZone: 'UTC', DateStyle: 'ISO, YMD', IntervalStyle: 'postgres', extra_float_digits: '1', bytea_output: 'hex' },
				tables: [{ name: 'users', columns: [{ name: 'id', type: 'uuid' }] }],
				excluded: []
			});
			writer.section('users');
			writer.row('{"id":"u1","note":"a\\\\nb \u2028 🏋️"}');
			writer.sequences([]);
			writer.finish();
			const archive = readArchive(openEnvelope(key, await sealed));
			let refused = null;
			try { openEnvelope(parseBackupKey(Buffer.alloc(32, 4).toString('base64url'), 'K'), await sealed); }
			catch (error) { refused = isBackupError(error, 'wrong_key') ? error.code : String(error); }
			console.log(JSON.stringify({ key: String(key), rows: archive.tables[0].rows, refused, loaded: loadedFiles() }));
		`);
		expect(result.stderr).not.toMatch(/Error/);
		expect(result.status).toBe(0);
		const output = JSON.parse(result.stdout) as Record<string, unknown>;
		expect(output.key).toMatch(/^\[BackupKey [0-9a-f]{16}\]$/);
		expect(output.rows).toEqual(['{"id":"u1","note":"a\\nb \u2028 🏋️"}']);
		expect(output.refused).toBe('wrong_key');
		// Loaded eagerly, by their real .ts paths, the archive with the domain format it reads.
		expect(output.loaded).toEqual(
			expect.arrayContaining([
				'src/lib/server/backup/key.ts',
				'src/lib/server/backup/envelope.ts',
				'src/lib/server/backup/archive.ts',
				'src/lib/server/backup/errors.ts',
				'src/lib/domain/backup/format.ts'
			])
		);
	});
});
