/**
 * The migrate script seeds the exercise library under plain Node (type stripping, no Vite), as
 * `pnpm db:migrate` and the Vercel build run it. So the catalogue must load without a bundler:
 * explicit .ts specifiers on every runtime import, and `import type` for everything else. It
 * lives in scripts/ because the domain lint block forbids node:child_process.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CATALOGUE, SUBSTITUTION_GROUPS } from '../src/lib/domain/exercises/index';

const root = fileURLToPath(new URL('../', import.meta.url));

/** Import `file` with the plain Node running this test and print `expression` as JSON. */
function plainNode(file: string, expression: string) {
	const script = `const m = await import(${JSON.stringify(file)}); console.log(JSON.stringify(${expression}));`;
	return spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
		cwd: root,
		encoding: 'utf8'
	});
}

describe('the exercise catalogue under plain Node', () => {
	it('loads src/lib/domain/exercises/index.ts with type stripping alone', () => {
		const result = plainNode(
			path.join(root, 'src/lib/domain/exercises/index.ts'),
			'{ catalogue: m.CATALOGUE.length, byKey: m.catalogueByKey.size, groups: Object.keys(m.SUBSTITUTION_GROUPS) }'
		);
		expect(result.stderr).not.toMatch(/Error/);
		expect(result.status).toBe(0);
		// The same library Vite loads, so the seed and the generator agree.
		expect(JSON.parse(result.stdout)).toEqual({
			catalogue: CATALOGUE.length,
			byKey: CATALOGUE.length,
			groups: Object.keys(SUBSTITUTION_GROUPS)
		});
	});

	it('loads src/lib/server/db/migrate.ts, the chain db:migrate and the Vercel build run', () => {
		// migrate.ts → seed/exercises.ts → domain/exercises: one bad specifier breaks every deploy.
		const result = plainNode(
			path.join(root, 'src/lib/server/db/migrate.ts'),
			'{ runMigrations: typeof m.runMigrations, resetDatabase: typeof m.resetDatabase }'
		);
		expect(result.stderr).not.toMatch(/Error/);
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({
			runMigrations: 'function',
			resetDatabase: 'function'
		});
	});

	it('would fail on an extensionless runtime import, which only Vite resolves', () => {
		const dir = mkdtempSync(path.join(tmpdir(), 'catalogue-node-'));
		try {
			const probe = path.join(dir, 'probe.ts');
			const catalog = path.join(root, 'src/lib/domain/profile/catalog');
			writeFileSync(probe, `export { EQUIPMENT } from ${JSON.stringify(catalog)};\n`);
			const result = plainNode(probe, 'm.EQUIPMENT.length');
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain('ERR_MODULE_NOT_FOUND');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
