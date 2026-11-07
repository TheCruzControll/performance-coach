import { createDecipheriv, randomBytes } from 'node:crypto';
import type * as NodeCrypto from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	ALGORITHM_AES_256_GCM,
	ENVELOPE_FORMAT,
	HEADER_BYTES,
	MAX_ENVELOPE_BYTES,
	TAG_BYTES,
	openEnvelope,
	sealStream
} from './envelope';
import { BackupError, type BackupErrorCode } from './errors';
import { BackupKey } from './key';

// Wraps the real decipher factory, so a test can tell whether a decipher was ever created.
vi.mock('node:crypto', async (importOriginal) => {
	const actual = await importOriginal<typeof NodeCrypto>();
	return { ...actual, createDecipheriv: vi.fn(actual.createDecipheriv) };
});

const KEY_BYTES = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff));
const KEY = new BackupKey(KEY_BYTES);
const OTHER = new BackupKey(Buffer.alloc(32, 7));

afterEach(() => {
	vi.mocked(createDecipheriv).mockClear();
});

/** A small deterministic PRNG (mulberry32), so every run flips and cuts the same bytes. */
function prng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** `bytes` cut into chunks: of one byte each, or of random sizes up to `max`. */
function chunked(bytes: Buffer, size: 'one' | { max: number; seed: number }): Buffer[] {
	const chunks: Buffer[] = [];
	const random = size === 'one' ? null : prng(size.seed);
	for (let at = 0; at < bytes.length;) {
		const length = random ? 1 + Math.floor(random() * (size as { max: number }).max) : 1;
		chunks.push(bytes.subarray(at, at + length));
		at += length;
	}
	return chunks;
}

async function seal(chunks: Buffer[], key = KEY): Promise<Buffer> {
	const out: Buffer[] = [];
	await pipeline(
		Readable.from(chunks, { objectMode: false }),
		sealStream(key),
		new Writable({
			write(chunk: Buffer, _encoding, done) {
				out.push(chunk);
				done();
			}
		})
	);
	return Buffer.concat(out);
}

function refusal(open: () => unknown): BackupErrorCode {
	try {
		open();
	} catch (error) {
		expect(error).toBeInstanceOf(BackupError);
		return (error as BackupError).code;
	}
	throw new Error('Expected the file to be refused');
}

/** The region an offset falls in, and the refusal a changed byte there must give. */
function expectedForFlip(offset: number): BackupErrorCode {
	if (offset < 4) return 'not_a_backup';
	if (offset < 6) return 'unsupported_format';
	if (offset < 14) return 'wrong_key';
	return 'tampered';
}

/** The refusal for a file cut to `length` bytes. */
function expectedForCut(length: number): BackupErrorCode {
	if (length < 4) return 'not_a_backup';
	if (length < HEADER_BYTES + TAG_BYTES) return 'truncated';
	return 'tampered';
}

describe('sealStream and openEnvelope', () => {
	const sizes: [label: string, bytes: number][] = [
		['0 B', 0],
		['1 B', 1],
		['64 KB', 64 * 1024],
		['8 MB', 8 * 1024 * 1024]
	];
	for (const [label, length] of sizes) {
		it(`round-trips ${label} fed in random chunks${length <= 64 * 1024 ? ' and in 1-byte chunks' : ''}`, async () => {
			const plaintext = randomBytes(length);
			const feeds: Buffer[][] = [chunked(plaintext, { max: 70_000, seed: length + 1 })];
			if (length <= 64 * 1024) feeds.push(chunked(plaintext, 'one'));
			for (const chunks of feeds) {
				const sealed = await seal(chunks);
				expect(sealed.length).toBe(HEADER_BYTES + length + TAG_BYTES);
				expect(openEnvelope(KEY, sealed).equals(plaintext)).toBe(true);
			}
		}, 60_000);
	}

	it('lays the file out as the header (also the AAD), the ciphertext, then the tag', async () => {
		const plaintext = Buffer.from('{"a":1}\n', 'utf8');
		const sealed = await seal([plaintext]);
		const header = sealed.subarray(0, HEADER_BYTES);
		// 4 + 1 + 1 + 8 + 12: the plan's '24-byte header' miscounts its own fields.
		expect(HEADER_BYTES).toBe(26);
		expect(header.subarray(0, 4).toString('latin1')).toBe('PCBK');
		expect(header[4]).toBe(ENVELOPE_FORMAT);
		expect(header[5]).toBe(ALGORITHM_AES_256_GCM);
		expect(header.subarray(6, 14)).toEqual(KEY.idBytes());
		const iv = header.subarray(14, 26);
		const body = sealed.subarray(HEADER_BYTES, sealed.length - TAG_BYTES);
		const tag = sealed.subarray(sealed.length - TAG_BYTES);

		const decrypt = (aad: Buffer | null) => {
			const decipher = createDecipheriv('aes-256-gcm', KEY_BYTES, iv, { authTagLength: 16 });
			if (aad) decipher.setAAD(aad);
			decipher.setAuthTag(tag);
			return Buffer.concat([decipher.update(body), decipher.final()]);
		};
		expect(decrypt(header)).toEqual(plaintext);
		// Without the header as AAD the tag does not verify: the header is authenticated.
		expect(() => decrypt(null)).toThrow();
	});

	it('gives every seal a fresh IV: 1,000 seals, 1,000 distinct IVs', async () => {
		const ivs = new Set<string>();
		for (let i = 0; i < 1000; i += 1) {
			const sealed = await seal([Buffer.from('x')]);
			ivs.add(sealed.subarray(14, 26).toString('hex'));
		}
		expect(ivs.size).toBe(1000);
	});

	it('is backpressured: writes report a full buffer until the sealed bytes are read', async () => {
		const stream = sealStream(KEY);
		const chunk = Buffer.alloc(16 * 1024, 1);
		let written = 0;
		while (stream.write(chunk)) {
			written += chunk.length;
			expect(written).toBeLessThan(1024 * 1024);
		}
		const drained = new Promise((resolve) => stream.once('drain', resolve));
		stream.resume();
		await drained;
		stream.destroy();
	});
});

describe('openEnvelope refusals', () => {
	const plaintext = Buffer.from(Array.from({ length: 1024 }, (_, i) => i & 0xff));
	let sealed: Buffer;
	const sealedOnce = async () => (sealed ??= await seal([plaintext]));

	it('refuses 200 seeded byte flips and a flip at every region boundary, by region', async () => {
		const file = await sealedOnce();
		const random = prng(20261107);
		const offsets = Array.from({ length: 200 }, () => Math.floor(random() * file.length));
		const end = file.length;
		const boundaries = [
			0,
			3,
			4,
			5,
			6,
			13,
			14,
			25,
			26,
			27,
			end - TAG_BYTES - 1,
			end - TAG_BYTES,
			end - 1
		];
		for (const offset of [...boundaries, ...offsets]) {
			const flipped = Buffer.from(file);
			flipped[offset]! ^= 1 << Math.floor(random() * 8);
			expect(
				refusal(() => openEnvelope(KEY, flipped)),
				`offset ${offset}`
			).toBe(expectedForFlip(offset));
		}
	});

	it('refuses the file cut at every length, before or inside the tag', async () => {
		const small = await seal([Buffer.from('{"a":1}\n{"b":2}\n')]);
		for (let length = 0; length < small.length; length += 1) {
			const code = refusal(() => openEnvelope(KEY, small.subarray(0, length)));
			expect(code, `length ${length}`).toBe(expectedForCut(length));
		}
		// And the 1 KB file at its region boundaries.
		const file = await sealedOnce();
		for (const length of [0, 4, 6, 14, 26, 41, 42, file.length - TAG_BYTES, file.length - 1]) {
			const code = refusal(() => openEnvelope(KEY, file.subarray(0, length)));
			expect(code, `length ${length}`).toBe(expectedForCut(length));
		}
	});

	it('refuses another key by its id, before any decipher is created', async () => {
		const file = await sealedOnce();
		const decipherFactory = vi.mocked(createDecipheriv);
		decipherFactory.mockClear();
		expect(refusal(() => openEnvelope(OTHER, file))).toBe('wrong_key');
		expect(decipherFactory).not.toHaveBeenCalled();
		// The right key does create one: the spy sees the envelope's decipher.
		expect(openEnvelope(KEY, file).equals(plaintext)).toBe(true);
		expect(decipherFactory).toHaveBeenCalledTimes(1);
	});

	it('names the key ids in a wrong-key refusal, never a key', async () => {
		const file = await sealedOnce();
		try {
			openEnvelope(OTHER, file);
			throw new Error('Expected a refusal');
		} catch (error) {
			const message = (error as Error).message;
			expect(message).toContain(OTHER.id);
			expect(message).not.toContain(KEY_BYTES.toString('hex').slice(0, 16));
			expect(message).not.toContain(KEY_BYTES.toString('base64').slice(0, 16));
		}
	});

	it('refuses a file over the cap before reading it', async () => {
		const file = await sealedOnce();
		const decipherFactory = vi.mocked(createDecipheriv);
		decipherFactory.mockClear();
		expect(refusal(() => openEnvelope(KEY, file, { maxBytes: file.length - 1 }))).toBe('too_large');
		// Checked before the magic: a huge non-backup is refused as too large, unread.
		expect(refusal(() => openEnvelope(KEY, Buffer.alloc(101), { maxBytes: 100 }))).toBe(
			'too_large'
		);
		expect(decipherFactory).not.toHaveBeenCalled();
		expect(openEnvelope(KEY, file, { maxBytes: file.length }).equals(plaintext)).toBe(true);
		expect(MAX_ENVELOPE_BYTES).toBe(512 * 1024 * 1024);
	});

	it('refuses bytes that are not a sealed backup at all', () => {
		for (const bytes of [
			Buffer.alloc(0),
			Buffer.from('PCB'),
			Buffer.alloc(100),
			Buffer.from('\x1f\x8b gzip')
		]) {
			expect(refusal(() => openEnvelope(KEY, bytes))).toBe('not_a_backup');
		}
	});

	it('opens a Uint8Array view of a larger buffer at its own offset', async () => {
		const file = await sealedOnce();
		const padded = Buffer.concat([Buffer.alloc(7, 9), file, Buffer.alloc(5, 9)]);
		const view = new Uint8Array(padded.buffer, padded.byteOffset + 7, file.length);
		expect(openEnvelope(KEY, view).equals(plaintext)).toBe(true);
	});
});
