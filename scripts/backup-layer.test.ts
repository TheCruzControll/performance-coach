/**
 * src/lib/server/backup is a leaf (eslint.config.js): it seals and reads backup files from
 * explicit inputs, so operator scripts can import it under plain Node and it can neither reach
 * state nor read its own configuration. Each case lints a snippet with ESLint's Node API against
 * the repository's real config, exactly as `pnpm lint` would see it at that path.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const eslint = new ESLint({ cwd: root });

const FILE = 'src/lib/server/backup/envelope.ts';
const IMPORTS = 'no-restricted-imports';
const PROPERTIES = 'no-restricted-properties';
const TIMEOUT = 60_000;

interface Finding {
	rule: string | null;
	message: string;
}

/** What ESLint reports for `code` at `file`; an ignored or unparsable file fails the test. */
async function lint(code: string, file = FILE): Promise<Finding[]> {
	if (await eslint.isPathIgnored(path.join(root, file))) throw new Error(`${file} is ignored`);
	const [result] = await eslint.lintText(code, { filePath: path.join(root, file) });
	const fatal = result!.messages.find((m) => m.fatal);
	if (fatal) throw new Error(`${file}: ${fatal.message}`);
	return result!.messages.map((m) => ({ rule: m.ruleId, message: m.message }));
}

const importing = (specifier: string) =>
	`import * as dependency from '${specifier}';\nexport const used = dependency;\n`;

/** Each specifier the backup layer must not import, and the message that names the reason. */
const FORBIDDEN: [specifier: string, message: RegExp][] = [
	['#lib/server/db/index.ts', /server\/backup is a leaf/],
	['../db/index.ts', /server\/backup is a leaf/],
	['$lib/server/db/schema/auth.ts', /server\/backup is a leaf/],
	['../db/backup/export.ts', /server\/backup is a leaf/],
	['#lib/server/services/index.ts', /server\/backup is a leaf/],
	['../services/backups/index.ts', /server\/backup is a leaf/],
	['../agent/index.ts', /server\/backup is a leaf/],
	['#lib/server/auth/index.ts', /server\/backup is a leaf/],
	['../auth/cron.ts', /server\/backup is a leaf/],
	['../forms/read.ts', /server\/backup is a leaf/],
	['#lib/server/env.ts', /server\/backup is a leaf/],
	['../env', /server\/backup is a leaf/],
	['../env.ts', /server\/backup is a leaf/],
	['$env/dynamic/private', /server\/backup is a leaf/],
	['$env/static/private', /server\/backup is a leaf/],
	['pg', /server\/backup is a leaf/],
	['drizzle-orm', /server\/backup is a leaf/],
	['$app/environment', /framework-agnostic/],
	['@sveltejs/kit', /framework-agnostic/],
	['svelte', /framework-agnostic/],
	['#lib/ui/components/Badge.svelte', /must not depend on UI/],
	['../../ui/components/Badge.svelte', /must not depend on UI/],
	['#lib/client/program.ts', /browser-only client code/]
];

describe('the backup layer imports', () => {
	for (const [specifier, message] of FORBIDDEN) {
		it(
			`refuses ${specifier}`,
			async () => {
				const findings = await lint(importing(specifier));
				expect(findings.map((f) => f.rule)).toEqual([IMPORTS]);
				expect(findings[0]!.message).toMatch(message);
			},
			TIMEOUT
		);
	}

	it(
		'allows the domain, Node built-ins and its own files, by relative .ts specifier',
		async () => {
			const code = [
				"import { createHash } from 'node:crypto';",
				"import { Transform } from 'node:stream';",
				"import { gunzipSync } from 'node:zlib';",
				"import { FORMAT_VERSION } from '../../domain/backup/format.ts';",
				"import { BackupError } from './errors.ts';",
				'export const used = [createHash, Transform, gunzipSync, FORMAT_VERSION, BackupError];',
				''
			].join('\n');
			expect(await lint(code)).toEqual([]);
			expect(await lint(code, 'src/lib/server/backup/archive.ts')).toEqual([]);
		},
		TIMEOUT
	);
});

describe('the backup layer reads no configuration', () => {
	it(
		'refuses process.env, read directly or destructured',
		async () => {
			for (const code of [
				'export const key = process.env.BACKUP_ENCRYPTION_KEY;\n',
				'const { env } = process;\nexport const key = env.BACKUP_ENCRYPTION_KEY;\n'
			]) {
				const findings = await lint(code, 'src/lib/server/backup/key.ts');
				expect(
					findings.map((f) => f.rule),
					code
				).toEqual([PROPERTIES]);
				expect(findings[0]!.message).toMatch(/reads no configuration/);
			}
		},
		TIMEOUT
	);
});

describe('the rule is the backup layer’s own', () => {
	it(
		'a service may import it and the env, as the backup run will',
		async () => {
			const code = [
				"import { parseBackupKey } from '../backup/key.ts';",
				"import { getEnv } from '../env';",
				'export const used = [parseBackupKey, getEnv, process.env.BACKUP_ENCRYPTION_KEY];',
				''
			].join('\n');
			expect(await lint(code, 'src/lib/server/services/backup-run.ts')).toEqual([]);
		},
		TIMEOUT
	);
});
