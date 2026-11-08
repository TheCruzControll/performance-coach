/**
 * `pnpm auth:setup-token`, spawned as the tech lead runs it (plain Node), and the helper e2e's
 * global setup mints its token through.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSetupToken } from '../src/lib/server/auth/tokens';
import {
	mintSetupToken,
	parseHours,
	SETUP_TOKEN_DEFAULT_HOURS,
	SETUP_TOKEN_MAX_HOURS
} from './auth-setup-token';

const root = fileURLToPath(new URL('../', import.meta.url));
const HOUR = 3_600_000;

function run(args: string[]) {
	const result = spawnSync(
		process.execPath,
		[path.join(root, 'scripts/auth-setup-token.ts'), ...args],
		{
			cwd: root,
			env: { PATH: process.env.PATH ?? '', TZ: 'America/Los_Angeles' },
			encoding: 'utf8',
			timeout: 20_000
		}
	);
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('mintSetupToken', () => {
	it('mints a token expiring 24 hours from now by default, with its SHA-256', () => {
		expect(SETUP_TOKEN_DEFAULT_HOURS).toBe(24);
		expect(SETUP_TOKEN_MAX_HOURS).toBe(168);
		const now = new Date('2026-11-07T09:30:15.250Z');
		const { token, hash, expiresAt } = mintSetupToken(undefined, now);
		expect(expiresAt).toEqual(new Date('2026-11-08T09:30:15Z'));
		expect(parseSetupToken(token)).toEqual({ expiresAt });
		expect(hash).toBe(createHash('sha256').update(token).digest('hex'));
		expect(mintSetupToken(2, now).expiresAt).toEqual(new Date('2026-11-07T11:30:15Z'));
	});

	it('takes --hours as a whole number from 1 to 168', () => {
		expect(parseHours('1')).toBe(1);
		expect(parseHours('168')).toBe(168);
		for (const bad of ['0', '169', '-1', '1.5', '24h', '', ' 24', '1e2']) {
			expect(parseHours(bad), bad).toBeNull();
		}
	});
});

describe('pnpm auth:setup-token', () => {
	it('prints a token that expires in --hours, with the expiry in UTC and local time', () => {
		const before = Date.now();
		const { status, stdout } = run(['--json', '--hours', '48']);
		expect(status).toBe(0);
		const out = JSON.parse(stdout) as {
			token: string;
			hash: string;
			link: string;
			expiresAt: string;
		};
		const { expiresAt } = parseSetupToken(out.token)!;
		expect(out.expiresAt).toBe(expiresAt.toISOString().replace('.000Z', 'Z'));
		expect(expiresAt.getTime()).toBeGreaterThanOrEqual(
			Math.floor(before / 1000) * 1000 + 48 * HOUR
		);
		expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 48 * HOUR);
		expect(out.hash).toBe(createHash('sha256').update(out.token).digest('hex'));
		expect(out.link).toBe(`https://coach.nikocruz.com/setup?token=${out.token}`);

		const text = run(['--origin', 'http://localhost:5173']);
		expect(text.status).toBe(0);
		const token = /\/setup\?token=(\S+)/.exec(text.stdout)![1]!;
		const expiry = parseSetupToken(token)!.expiresAt;
		const utc = expiry.toISOString().replace('.000Z', 'Z');
		expect(text.stdout).toContain(`It expires in 24 h: ${utc} (UTC)`);
		// The same instant in the machine's zone (TZ above).
		const local = expiry.toLocaleString('en-GB', {
			timeZone: 'America/Los_Angeles',
			weekday: 'short',
			day: 'numeric',
			month: 'short',
			year: 'numeric',
			hour: '2-digit',
			minute: '2-digit',
			timeZoneName: 'short'
		});
		expect(local).toMatch(/GMT-[78]$/);
		expect(text.stdout).toContain(`(UTC), ${local} on this machine.`);
		expect(text.stdout).toContain(
			`OWNER_SETUP_TOKEN_HASH=${createHash('sha256').update(token).digest('hex')}`
		);
	});

	it('refuses --hours 0 and 169 before minting anything', () => {
		for (const hours of ['0', '169', 'x']) {
			const { status, stdout, stderr } = run(['--hours', hours]);
			expect(status, hours).toBe(1);
			expect(stdout).toBe('');
			expect(stderr).toContain('--hours must be a whole number from 1 to 168.');
		}
	});
});
