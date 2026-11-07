/**
 * The `pnpm auth:reset-owner` guards, run as the real command against the test database: it
 * shows what it would do, then refuses without `--confirm`, and refuses outside an interactive
 * terminal even with it. Nothing changes either way. (Without DATABASE_URL_UNPOOLED it refuses
 * before connecting: scripts/auth-reset-owner.test.ts. The reset itself: setup.test.ts.)
 */
import { spawnSync } from 'node:child_process';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getDb } from '../../../src/lib/server/db';

const root = new URL('../../../', import.meta.url);

function resetOwner(args: string[]) {
	return spawnSync(process.execPath, ['scripts/auth-reset-owner.ts', ...args], {
		cwd: root,
		env: { PATH: process.env.PATH ?? '', DATABASE_URL_UNPOOLED: process.env.DATABASE_URL_UNPOOLED },
		input: '', // stdin is a pipe, not a terminal
		encoding: 'utf8',
		timeout: 15_000
	});
}

async function resets(): Promise<number> {
	const result = await getDb().execute<{ n: number }>(
		sql`select count(*)::int as n from auth_events where type = 'owner.reset'`
	);
	return result.rows[0]!.n;
}

describe('pnpm auth:reset-owner', () => {
	it('shows the target and the plan, then refuses without --confirm', async () => {
		const before = await resets();
		const result = resetOwner([]);
		expect(result.status, result.stderr).toBe(2);
		expect(result.stdout).toMatch(/Database: postgres:\/\/[^@]*\*\*\*@/); // password redacted
		expect(result.stdout).toContain('reopen first-run setup');
		expect(result.stdout).toMatch(/Will delete \d+ passkey\(s\), \d+ email sign-in link\(s\)/);
		expect(result.stderr).toContain('Refusing to run without --confirm.');
		expect(await resets()).toBe(before);
	});

	it('refuses to run non-interactively, even with --confirm', async () => {
		const before = await resets();
		const result = resetOwner(['--confirm']);
		expect(result.status, result.stderr).toBe(2);
		expect(result.stderr).toContain('Refusing to run non-interactively');
		expect(result.stdout).not.toContain('Reset done');
		expect(await resets()).toBe(before);
	});
});
