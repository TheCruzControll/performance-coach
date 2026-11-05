import { describe, expect, it } from 'vitest';
import { connectionConfig } from './connection.ts';

const NEON =
	'postgresql://neondb_owner:p%40ss@ep-x-pooler.c-5.us-west-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

describe('connectionConfig', () => {
	it('pins Neon strings to verify-full TLS and turns on SCRAM channel binding', () => {
		const config = connectionConfig(NEON);
		expect(config.enableChannelBinding).toBe(true);
		const url = new URL(config.connectionString);
		expect(url.searchParams.get('sslmode')).toBe('verify-full');
		expect(url.searchParams.has('channel_binding')).toBe(false);
		// Credentials, host and database are untouched (still percent-encoded).
		expect(url.username).toBe('neondb_owner');
		expect(url.password).toBe('p%40ss');
		expect(url.host).toBe('ep-x-pooler.c-5.us-west-2.aws.neon.tech');
		expect(url.pathname).toBe('/neondb');
	});

	it('upgrades every mode node-postgres 8 already treats as verify-full', () => {
		for (const mode of ['prefer', 'require', 'verify-ca']) {
			const { connectionString } = connectionConfig(`postgres://u@h/db?sslmode=${mode}`);
			expect(new URL(connectionString).searchParams.get('sslmode')).toBe('verify-full');
		}
	});

	it('leaves local strings and stricter or explicit modes alone', () => {
		const local = 'postgres://coach:coach@localhost:5432/coach_dev';
		expect(connectionConfig(local)).toEqual({
			connectionString: local,
			enableChannelBinding: false
		});
		for (const mode of ['disable', 'verify-full', 'no-verify']) {
			const { connectionString } = connectionConfig(`postgres://u@h/db?sslmode=${mode}`);
			expect(new URL(connectionString).searchParams.get('sslmode')).toBe(mode);
		}
		expect(connectionConfig('postgres://u@h/db?channel_binding=disable').enableChannelBinding).toBe(
			false
		);
	});

	it('passes unparseable strings through for pg to report', () => {
		expect(connectionConfig('not a url')).toEqual({
			connectionString: 'not a url',
			enableChannelBinding: false
		});
	});
});
