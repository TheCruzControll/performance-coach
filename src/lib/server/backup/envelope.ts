/**
 * The sealed file (the app-level encrypted backups ADR): AES-256-GCM from node:crypto, laid out
 * as
 *
 *   offset 0   'PCBK'                        magic, 4 bytes
 *   offset 4   ENVELOPE_FORMAT               1 byte
 *   offset 5   ALGORITHM_AES_256_GCM         1 byte
 *   offset 6   the key id                    8 bytes
 *   offset 14  a random IV                   12 bytes
 *   offset 26  the ciphertext                any length
 *   last 16    the GCM tag
 *
 * The 26-byte header is the AAD, so no byte of it can change unnoticed. A fresh random 96-bit IV
 * per file is far inside GCM's limits at about 400 files a year.
 *
 * Opening a file checks the cap, the magic, the format, the algorithm and the key id before any
 * decryption, and releases plaintext only once the tag verifies. Server-only by use; imported by
 * path with relative .ts specifiers, so scripts run it under plain Node.
 */
import { randomBytes } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import { BackupError } from './errors.ts';
import { KEY_ID_BYTES, type BackupKey } from './key.ts';

export const ENVELOPE_MAGIC = Buffer.from('PCBK', 'latin1');
export const ENVELOPE_FORMAT = 1;
export const ALGORITHM_AES_256_GCM = 1;
export const IV_BYTES = 12;
export const HEADER_BYTES = ENVELOPE_MAGIC.length + 2 + KEY_ID_BYTES + IV_BYTES;
export const TAG_BYTES = 16;
/**
 * The largest sealed file opened, checked before anything else. A backup is a few MB; the cap
 * keeps a wrong or hostile file from exhausting memory.
 */
export const MAX_ENVELOPE_BYTES = 512 * 1024 * 1024;

const FORMAT_OFFSET = ENVELOPE_MAGIC.length;
const ALGORITHM_OFFSET = FORMAT_OFFSET + 1;
const KEY_ID_OFFSET = ALGORITHM_OFFSET + 1;
const IV_OFFSET = KEY_ID_OFFSET + KEY_ID_BYTES;

function sealHeader(key: BackupKey, iv: Buffer): Buffer {
	return Buffer.concat([
		ENVELOPE_MAGIC,
		Buffer.of(ENVELOPE_FORMAT, ALGORITHM_AES_256_GCM),
		key.idBytes(),
		iv
	]);
}

/**
 * A Transform that seals what is written to it: the header, the ciphertext as it comes, then the
 * tag when it ends. It holds no more than the stream's buffers, so a slow reader slows the writer.
 */
export function sealStream(key: BackupKey): Transform {
	const iv = randomBytes(IV_BYTES);
	const header = sealHeader(key, iv);
	const cipher = key.cipher(iv);
	cipher.setAAD(header);
	let started = false;
	const start = (stream: Transform) => {
		if (!started) {
			started = true;
			stream.push(header);
		}
	};
	return new Transform({
		transform(this: Transform, chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback) {
			start(this);
			done(null, cipher.update(chunk));
		},
		flush(this: Transform, done: TransformCallback) {
			start(this);
			const last = cipher.final();
			if (last.length > 0) this.push(last);
			done(null, cipher.getAuthTag());
		}
	});
}

export interface OpenOptions {
	/** The largest file accepted; MAX_ENVELOPE_BYTES by default. */
	maxBytes?: number;
}

/**
 * Opens a sealed file. Refusals, in the order they are checked: too_large, not_a_backup,
 * unsupported_format, truncated, wrong_key (no decipher is created), then tampered when the tag
 * does not verify. The plaintext is returned only after it does.
 */
export function openEnvelope(
	key: BackupKey,
	bytes: Uint8Array,
	{ maxBytes = MAX_ENVELOPE_BYTES }: OpenOptions = {}
): Buffer {
	if (bytes.length > maxBytes) {
		throw new BackupError('too_large', `The file is over the ${maxBytes}-byte cap`);
	}
	const file = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
	if (
		file.length < ENVELOPE_MAGIC.length ||
		!file.subarray(0, FORMAT_OFFSET).equals(ENVELOPE_MAGIC)
	) {
		throw new BackupError('not_a_backup', 'The file is not a sealed backup');
	}
	if (file.length > FORMAT_OFFSET && file[FORMAT_OFFSET] !== ENVELOPE_FORMAT) {
		throw new BackupError('unsupported_format', 'The envelope format is not one this code reads');
	}
	if (file.length > ALGORITHM_OFFSET && file[ALGORITHM_OFFSET] !== ALGORITHM_AES_256_GCM) {
		throw new BackupError(
			'unsupported_format',
			'The envelope algorithm is not one this code reads'
		);
	}
	if (file.length < HEADER_BYTES + TAG_BYTES) {
		throw new BackupError('truncated', 'The file ends before its header and tag');
	}
	const header = file.subarray(0, HEADER_BYTES);
	if (!header.subarray(KEY_ID_OFFSET, IV_OFFSET).equals(key.idBytes())) {
		throw new BackupError('wrong_key', `The file was sealed with another key than ${key.id}`);
	}
	const decipher = key.decipher(header.subarray(IV_OFFSET, HEADER_BYTES));
	decipher.setAAD(header);
	decipher.setAuthTag(file.subarray(file.length - TAG_BYTES));
	const plaintext = decipher.update(file.subarray(HEADER_BYTES, file.length - TAG_BYTES));
	try {
		decipher.final();
	} catch {
		plaintext.fill(0);
		throw new BackupError('tampered', 'The file does not verify: it was changed or cut short');
	}
	return plaintext;
}
