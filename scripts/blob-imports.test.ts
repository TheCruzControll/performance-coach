/**
 * Only src/lib/server/backup/blob-store.ts imports @vercel/blob (eslint.config.js), so no other
 * code can upload a backup publicly or with whatever token the environment holds. Each case lints
 * a snippet with ESLint's Node API against the repository's real config, exactly as `pnpm lint`
 * would see it at that path.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const eslint = new ESLint({ cwd: root });
const RULE = 'no-restricted-syntax';
const TIMEOUT = 60_000;

async function rules(code: string, file: string): Promise<(string | null)[]> {
	const [result] = await eslint.lintText(code, { filePath: path.join(root, file) });
	const fatal = result!.messages.find((m) => m.fatal);
	if (fatal) throw new Error(`${file}: ${fatal.message}`);
	return result!.messages.map((m) => m.ruleId);
}

const FORMS: [form: string, code: string][] = [
	['an import', "import { put } from '@vercel/blob';\nexport const used = put;\n"],
	[
		'a type import',
		"import type { PutBlobResult } from '@vercel/blob';\nexport type T = PutBlobResult;\n"
	],
	['a subpath', "import { upload } from '@vercel/blob/client';\nexport const used = upload;\n"],
	['a dynamic import', "export const load = () => import('@vercel/blob');\n"],
	['a re-export', "export { put } from '@vercel/blob';\n"],
	['an export star', "export * from '@vercel/blob';\n"]
];

const ELSEWHERE = [
	'src/lib/server/backup/blob-probe.ts',
	'src/lib/server/backup/prune.ts',
	'src/lib/server/services/backup-run.ts',
	'src/routes/api/cron/backup/+server.ts',
	'scripts/backup-list.ts'
];

describe('@vercel/blob imports', () => {
	for (const file of ELSEWHERE) {
		for (const [form, code] of FORMS) {
			it(
				`refuses ${form} in ${file}`,
				async () => expect(await rules(code, file)).toEqual([RULE]),
				TIMEOUT
			);
		}
	}

	it(
		'allows the store adapter and tests, and leaves look-alike packages alone',
		async () => {
			for (const [, code] of FORMS) {
				expect(await rules(code, 'src/lib/server/backup/blob-store.ts')).toEqual([]);
				expect(await rules(code, 'src/lib/server/backup/blob-store.test.ts')).toEqual([]);
			}
			const lookAlike = "import { x } from '@vercel/blobby';\nexport const used = x;\n";
			expect(await rules(lookAlike, 'src/lib/server/services/backup-run.ts')).toEqual([]);
		},
		TIMEOUT
	);
});
