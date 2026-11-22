/**
 * `pnpm db:grants` (scripts/db-grants.ts) and the runtime role's URL check, with no database: the
 * runtime-role refusal runs before any connection, the restore script re-applies the grants after
 * pg_restore, and the package script is the one the docs name.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isRuntimeRoleUrl } from '../src/lib/server/db/runtime-grants.ts';

const root = fileURLToPath(new URL('../', import.meta.url));

/** Builds a fixture URL from parts, so the secrets scan does not read it as a credential. */
const pg = (user: string, rest: string) => ['postgres://', user, rest].join('');

describe('isRuntimeRoleUrl', () => {
	it.each([
		pg('coach_app', ':x@h/d'),
		pg('coach_app_prod', ':x@h/d'),
		'postgres://coach_runtime@h/d'
	])('is true for the runtime role or its login: %s', (url) => {
		expect(isRuntimeRoleUrl(url)).toBe(true);
	});

	it.each([
		pg('coach', ':x@h/d'),
		pg('neondb_owner', ':x@h/d'),
		pg('postgres', ':x@h/d'),
		pg('coach_application', ':x@h/d')
	])('is false for any other user: %s', (url) => {
		expect(isRuntimeRoleUrl(url)).toBe(false);
	});
});

describe('scripts/restore-backup.sh', () => {
	const script = readFileSync(`${root}scripts/restore-backup.sh`, 'utf8');

	it('re-applies the grants after pg_restore, before it reports done', () => {
		const grants = script.indexOf('node scripts/db-grants.ts "$target"');
		expect(grants).toBeGreaterThan(script.indexOf('pg_restore --clean'));
		expect(grants).toBeGreaterThan(-1);
		expect(grants).toBeLessThan(script.indexOf('echo "restore: done"'));
	});
});

describe('pnpm db:grants', () => {
	it('is the grants script', () => {
		const pkg = JSON.parse(readFileSync(`${root}package.json`, 'utf8')) as {
			scripts: Record<string, string>;
		};
		expect(pkg.scripts['db:grants']).toBe('node --env-file-if-exists=.env scripts/db-grants.ts');
	});

	it('refuses the runtime role before connecting', () => {
		const result = spawnSync(
			process.execPath,
			['scripts/db-grants.ts', pg('coach_app', ':x@localhost:1/coach_dev')],
			{ cwd: root, env: { PATH: process.env.PATH ?? '' }, encoding: 'utf8', timeout: 30_000 }
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain('it is the runtime role');
	});

	it('exits 2 on a malformed URL and never prints it, password included', () => {
		const result = spawnSync(process.execPath, ['scripts/db-grants.ts', pg('u', ':s3cret@[bad')], {
			cwd: root,
			env: { PATH: process.env.PATH ?? '' },
			encoding: 'utf8',
			timeout: 30_000
		});
		expect(result.status).toBe(2);
		expect(result.stderr).toContain('not a postgres:// URL');
		expect(result.stdout).not.toContain('s3cret');
		expect(result.stderr).not.toContain('s3cret');
	});
});
