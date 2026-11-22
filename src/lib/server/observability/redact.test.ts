import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	EMAIL_MASK,
	MAX_STACK,
	MAX_TEXT,
	pathOnly,
	REDACTED,
	redactText,
	redactValue
} from './redact';

// Sentinels are built by concatenation, so the secret scan does not read this file as a leak.
const anthropicKey = 'sk-ant-' + 'api03-AAAAbbbbCCCCdddd1234';
const resendKey = 're_' + 'abcd1234_EFGHijkl5678';
const blobToken = 'vercel_blob_rw_' + 'StoreId123_abcDEF456ghi';
const neonKey = 'npg_' + 'AbCdEf123456XyZ';
const pemBlock = '-----BEGIN ' + 'PRIVATE KEY-----\nMIIBabc123\n-----END PRIVATE KEY-----';

afterEach(() => {
	vi.unstubAllEnvs();
});

describe('redactValue on shared references', () => {
	it('stops after MAX_NODES objects, so a wide shared graph cannot fan out', () => {
		let node: Record<string, unknown> = { leaf: 'x' };
		for (let level = 0; level < 8; level++) {
			const child = node;
			node = Object.fromEntries(Array.from({ length: 8 }, (_, k) => [`k${k}`, child]));
		}
		expect(JSON.stringify(redactValue(node))).toContain('[truncated]');
	}, 2000);
});

describe('redactText', () => {
	it('masks the password of a Postgres URL and keeps the rest', () => {
		const password = ['s3cret', 'Pass'].join('');
		expect(redactText(`postgres://coach_app:${password}@db.example.test:5432/coach`)).toBe(
			`postgres://coach_app:${REDACTED}@db.example.test:5432/coach`
		);
		expect(redactText(`postgresql://coach_app:${password}@db.example.test/coach`)).toBe(
			`postgresql://coach_app:${REDACTED}@db.example.test/coach`
		);
	});

	it('masks a Bearer token and leaves prose about a bearer alone', () => {
		expect(redactText('Authorization: Bearer abcdEFGH1234.xyz')).toBe(
			`Authorization: Bearer ${REDACTED}`
		);
		expect(redactText('Bearer token expired')).toBe('Bearer token expired');
	});

	it('masks provider keys inside a sentence and keeps the words around them', () => {
		expect(redactText(`key ${anthropicKey} was rejected`)).toBe(`key ${REDACTED} was rejected`);
		expect(redactText(`resend said ${resendKey} is invalid`)).toBe(
			`resend said ${REDACTED} is invalid`
		);
		expect(redactText(`store used ${blobToken} here`)).toBe(`store used ${REDACTED} here`);
		expect(redactText(`branch ${neonKey} is down`)).toBe(`branch ${REDACTED} is down`);
	});

	it('masks a PEM private key whole', () => {
		expect(redactText(`before ${pemBlock} after`)).toBe(`before ${REDACTED} after`);
	});

	it('masks the query string of a URL and keeps its fragment', () => {
		expect(redactText('https://coach.example.test/setup?token=abc123#x')).toBe(
			`https://coach.example.test/setup?${REDACTED}#x`
		);
	});

	it('masks an email address but not a Firefox stack frame', () => {
		expect(redactText('owner@example.test')).toBe(EMAIL_MASK);
		expect(redactText('sync@https://coach.example.test/_app/x.js:1:2')).toBe(
			'sync@https://coach.example.test/_app/x.js:1:2'
		);
	});

	it('removes the exact values of secret variables, and ignores short ones', () => {
		vi.stubEnv('CRON_SECRET', 'sentinel-cron-0123456789');
		vi.stubEnv('BACKUP_ENCRYPTION_KEY', 'sentinel-backup-key-ABCDEF');
		const out = redactText(
			'cron sentinel-cron-0123456789 and backup sentinel-backup-key-ABCDEF failed'
		);
		expect(out).not.toContain('sentinel-cron-0123456789');
		expect(out).not.toContain('sentinel-backup-key-ABCDEF');
		expect(out).toBe(`cron ${REDACTED} and backup ${REDACTED} failed`);

		vi.stubEnv('CRON_SECRET', 'short');
		expect(redactText('short circuit')).toBe('short circuit');
	});

	it('caps text at 2 048 characters after redaction, and keeps a stack whole up to 8 192', () => {
		expect(redactText('a'.repeat(3000))).toBe(`${'a'.repeat(MAX_TEXT)}… [952 more chars]`);
		expect(redactText('b'.repeat(5000), MAX_STACK)).toBe('b'.repeat(5000));
	});

	it('caps a long run of characters that the patterns are slow on, without stalling', () => {
		for (const long of ['a'.repeat(65536), 'deadbeef'.repeat(8192), 'http://'.repeat(9362)]) {
			const out = redactText(long, MAX_TEXT);
			expect(out.slice(0, MAX_TEXT)).toBe(long.slice(0, MAX_TEXT));
			expect(out.slice(MAX_TEXT)).toMatch(/^… \[\d+ more chars\]$/);
		}
	}, 2000);

	it('removes a secret value at character 60 000 of a long text', () => {
		vi.stubEnv('CRON_SECRET', 'sentinel-cron-0123456789');
		const out = redactText(`${'x'.repeat(60000)}sentinel-cron-0123456789${'y'.repeat(100)}`);
		expect(out).not.toContain('sentinel');
		expect(out.slice(0, MAX_TEXT)).toBe('x'.repeat(MAX_TEXT));
	});
});

describe('redactValue', () => {
	it('redacts every credential-named field, whatever its shape', () => {
		const out = redactValue({
			headers: { authorization: 'x', Cookie: 'y' },
			password: 'p',
			apiKey: 'k',
			BLOB_READ_WRITE_TOKEN: 't',
			private_key: { a: 1 }
		});
		expect(out).toEqual({
			headers: { authorization: REDACTED, Cookie: REDACTED },
			password: REDACTED,
			apiKey: REDACTED,
			BLOB_READ_WRITE_TOKEN: REDACTED,
			private_key: REDACTED
		});
	});

	it('keeps innocent fields and the scalar flags named after tokens', () => {
		const value = {
			key: 'exercise:bench',
			idempotencyKey: 'abc',
			inputTokens: 120,
			hasToken: true,
			tokenCount: 3,
			requestId: 'r1'
		};
		expect(redactValue(value)).toEqual(value);
	});

	it('redacts a string nested in an array in an object', () => {
		expect(redactValue({ a: [{ b: 'Bearer abcdEFGH1234' }] })).toEqual({
			a: [{ b: `Bearer ${REDACTED}` }]
		});
	});

	it('keeps a stack field whole up to 8 192 characters, and caps a message field', () => {
		const long = 'x'.repeat(5000);
		expect(redactValue({ stack: long })).toEqual({ stack: long });
		expect(redactValue({ message: long })).toEqual({
			message: `${'x'.repeat(MAX_TEXT)}… [${5000 - MAX_TEXT} more chars]`
		});
	});

	it('returns a self-referencing object without throwing, marking the cycle', () => {
		const cyclic: Record<string, unknown> = { name: 'loop' };
		cyclic.self = cyclic;
		const out = redactValue(cyclic);
		expect(out).toEqual({ name: 'loop', self: '[circular]' });
	});

	it('marks each self-reference of an object with 8 keys instead of expanding it', () => {
		const cyclic: Record<string, unknown> = {};
		for (const key of ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']) cyclic[key] = cyclic;
		expect(redactValue(cyclic)).toEqual({
			a: '[circular]',
			b: '[circular]',
			c: '[circular]',
			d: '[circular]',
			e: '[circular]',
			f: '[circular]',
			g: '[circular]',
			h: '[circular]'
		});
	}, 2000);
});

describe('pathOnly', () => {
	it('drops the query string and fragment of a path', () => {
		expect(pathOnly('/setup?token=x#y')).toBe('/setup');
		expect(pathOnly('/train')).toBe('/train');
		expect(pathOnly('?a')).toBe('/');
	});
});
