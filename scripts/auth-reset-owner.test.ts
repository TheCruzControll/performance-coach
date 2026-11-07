/**
 * `pnpm auth:reset-owner` deletes every credential of the owner, so it must only ever touch the
 * database it was explicitly pointed at. Without DATABASE_URL_UNPOOLED it refuses before
 * connecting anywhere (the `--confirm` and interactive-terminal refusals need a database to show
 * the plan first: tests/integration/auth/reset-owner-cli.test.ts).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resetOwnerAuth, resetTarget } from './auth-reset-owner';

const root = new URL('../', import.meta.url);

describe('owner reset target', () => {
	it('is not read from .env by `pnpm auth:reset-owner`', () => {
		// .env (copied from .env.example) sets DATABASE_URL_UNPOOLED to the local dev database, so
		// loading it would hand the reset a target nobody named on the command line.
		const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as {
			scripts: Record<string, string>;
		};
		expect(pkg.scripts['auth:reset-owner']).not.toMatch(/--env-file/);
	});

	it('is only ever DATABASE_URL_UNPOOLED, never DATABASE_URL or a local default', () => {
		const direct = 'postgres://u:p@ep-x.us-west-2.aws.neon.tech/neondb?sslmode=require';
		expect(resetTarget({ DATABASE_URL_UNPOOLED: direct })).toBe(direct);
		expect(resetTarget({ DATABASE_URL: 'postgres://u:p@pooler/neondb' })).toBeNull();
		expect(resetTarget({ DATABASE_URL_UNPOOLED: '  ' })).toBeNull();
		expect(resetTarget({})).toBeNull();
	});

	it('refuses to run without DATABASE_URL_UNPOOLED, before connecting to any database', () => {
		const result = spawnSync(process.execPath, ['scripts/auth-reset-owner.ts', '--confirm'], {
			cwd: root,
			// A configured app database is not enough (and is never reached: port 1 refuses).
			env: { PATH: process.env.PATH ?? '', DATABASE_URL: 'postgres://u:p@127.0.0.1:1/neondb' },
			input: '',
			encoding: 'utf8',
			timeout: 15_000
		});
		expect(result.status, result.stderr).toBe(2);
		expect(result.stderr).toContain('Refusing to run: set DATABASE_URL_UNPOOLED');
		expect(result.stdout).not.toContain('Database:');
		expect(result.stderr).not.toMatch(/ECONNREFUSED/);
	});
});

describe('owner reset', () => {
	it('deletes every email sign-in link and counts them in the summary and the audit event', async () => {
		const statements: { text: string; values?: unknown[] }[] = [];
		const rowCounts: [RegExp, number][] = [
			[/^update auth_sessions/, 2],
			[/^delete from passkey_credentials$/, 3],
			[/^delete from recovery_codes$/, 10],
			[/^delete from email_sign_in_links$/, 4]
		];
		const client = {
			query: async (text: string, values?: unknown[]) => {
				statements.push({ text, values });
				const rows = /^select id, display_name/.test(text)
					? [{ id: 'owner-1', display_name: 'Niko Cruz' }]
					: [];
				const rowCount = rowCounts.find(([pattern]) => pattern.test(text.trim()))?.[1] ?? 0;
				return { rows, rowCount };
			}
		} as unknown as Parameters<typeof resetOwnerAuth>[0];

		expect(await resetOwnerAuth(client)).toEqual({
			ownerName: 'Niko Cruz',
			passkeys: 3,
			sessions: 2,
			recoveryCodes: 10,
			emailLinks: 4
		});
		const texts = statements.map((s) => s.text.trim());
		expect(texts).toContain('delete from email_sign_in_links');
		// Inside the one transaction, before the audit event that reports it.
		expect(texts[0]).toBe('begin');
		expect(texts.at(-1)).toBe('commit');
		const audit = statements.find((s) => s.text.includes("'owner.reset'"))!;
		expect(texts.indexOf('delete from email_sign_in_links')).toBeLessThan(
			texts.indexOf(audit.text.trim())
		);
		expect(JSON.parse(audit.values![1] as string)).toMatchObject({ emailLinks: 4 });
	});
});
