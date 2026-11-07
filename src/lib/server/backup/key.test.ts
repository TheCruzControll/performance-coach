import { createHash, randomBytes } from 'node:crypto';
import { format, inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { BackupError } from './errors';
import { BackupKey, KEY_ID_LABEL, parseBackupKey } from './key';

const NAME = 'BACKUP_ENCRYPTION_KEY';

/** A key whose bytes are easy to spot in any text: 32 bytes of a recognisable pattern. */
const BYTES = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff));

function refusal(text: string): BackupError {
	try {
		parseBackupKey(text, NAME);
	} catch (error) {
		expect(error).toBeInstanceOf(BackupError);
		return error as BackupError;
	}
	throw new Error('Expected the key to be refused');
}

describe('parseBackupKey', () => {
	it('accepts 32 bytes in base64 and in base64url, padded or not, as the same key', () => {
		const forms = [
			BYTES.toString('base64'),
			BYTES.toString('base64url'),
			BYTES.toString('base64url') + '=',
			`  ${BYTES.toString('base64')}\n`
		];
		// The pattern needs both alphabets' special characters to tell the two apart.
		expect(forms[0]).toMatch(/[+/]/);
		expect(forms[1]).toMatch(/[-_]/);
		const ids = forms.map((text) => parseBackupKey(text, NAME).id);
		expect(new Set(ids).size).toBe(1);
	});

	it('derives the id from a fixed label and the key: 8 bytes of SHA-256, in hex', () => {
		const expected = createHash('sha256').update(KEY_ID_LABEL).update(BYTES).digest();
		const key = parseBackupKey(BYTES.toString('base64'), NAME);
		expect(key.id).toBe(expected.subarray(0, 8).toString('hex'));
		expect(key.idBytes()).toEqual(expected.subarray(0, 8));
		// Never the bare key's hash, so the id says nothing about another use of the same bytes.
		expect(key.id).not.toBe(createHash('sha256').update(BYTES).digest('hex').slice(0, 16));
	});

	it('refuses 31 and 33 bytes, naming the variable and the length', () => {
		for (const length of [31, 33, 16, 64]) {
			for (const encoding of ['base64', 'base64url'] as const) {
				const error = refusal(randomBytes(length).toString(encoding));
				expect(error.code).toBe('invalid_key');
				expect(error.message).toContain(NAME);
				expect(error.message).toContain(`decodes to ${length} bytes`);
			}
		}
	});

	it('refuses empty, mixed-alphabet, non-base64 and non-canonical text', () => {
		const b64 = BYTES.toString('base64');
		// The last character's two low bits are spare: setting one spells the same bytes again.
		const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
		const nonCanonical = b64.slice(0, 42) + alphabet[alphabet.indexOf(b64[42]!) ^ 1] + '=';
		expect(Buffer.from(nonCanonical, 'base64')).toEqual(BYTES.subarray(0, 32));
		for (const text of [
			'',
			'   ',
			b64.replace('+', '-'),
			b64.replace(/=$/, '!'),
			'x'.repeat(43) + '==',
			nonCanonical,
			BYTES.toString('hex')
		]) {
			expect(refusal(text).code, JSON.stringify(text)).toBe('invalid_key');
		}
	});

	it('never puts the input in an error message', () => {
		const inputs = [
			randomBytes(31).toString('base64'),
			randomBytes(33).toString('base64url'),
			BYTES.toString('hex'),
			'not-a-key-but-a-secret-sentence!',
			BYTES.toString('base64').replace('+', '-')
		];
		for (const text of inputs) {
			const error = refusal(text);
			for (const shown of [error.message, String(error), inspect(error), JSON.stringify(error)]) {
				expect(shown).not.toContain(text);
				expect(shown).not.toContain(text.slice(0, 12));
			}
		}
	});
});

describe('a BackupKey', () => {
	const key = parseBackupKey(BYTES.toString('base64'), NAME);
	/** Every spelling of the key's bytes that could leak into a log. */
	const spellings = ['base64', 'base64url', 'hex', 'latin1'].map((e) =>
		BYTES.toString(e as BufferEncoding)
	);

	it("prints as '[BackupKey <id>]' in every string form", () => {
		const forms = [
			String(key),
			`${key}`,
			'' + key,
			key.toString(),
			JSON.stringify(key),
			JSON.stringify({ key }),
			inspect(key),
			inspect(key, { showHidden: true, depth: 10 }),
			inspect({ nested: { key } }, { showHidden: true }),
			format('%s %o %O %j', key, key, key, key)
		];
		for (const shown of forms) {
			expect(shown).toContain(`[BackupKey ${key.id}]`);
			for (const spelling of spellings) expect(shown).not.toContain(spelling);
			// Not even a fragment of the key's bytes in hex.
			expect(shown).not.toContain(BYTES.toString('hex').slice(0, 16));
		}
	});

	it('holds its bytes in a private field: no own property or JSON key carries them', () => {
		const values = Object.getOwnPropertyNames(key).map(
			(name) => (key as unknown as Record<string, unknown>)[name]
		);
		expect(Object.keys(key)).toEqual(['id']);
		for (const value of values) {
			expect(Buffer.isBuffer(value)).toBe(false);
			for (const spelling of spellings) expect(String(value)).not.toContain(spelling);
		}
		expect(Object.getOwnPropertySymbols(key)).toEqual([]);
	});

	it('copies the bytes it is given, so wiping the caller’s buffer does not change it', () => {
		const bytes = Buffer.from(BYTES);
		const fromBytes = new BackupKey(bytes);
		bytes.fill(0);
		expect(fromBytes.id).toBe(key.id);
	});

	it('refuses to be built from anything but 32 bytes', () => {
		for (const length of [0, 31, 33]) {
			expect(() => new BackupKey(Buffer.alloc(length))).toThrow(
				expect.objectContaining({ code: 'invalid_key' })
			);
		}
	});
});
