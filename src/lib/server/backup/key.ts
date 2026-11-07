/**
 * BACKUP_ENCRYPTION_KEY as an opaque value (the app-level encrypted backups ADR). The 32 key
 * bytes live in a private field: every string form of a key, its JSON and its inspection print
 * `[BackupKey <id>]`, so a key logged by mistake shows only its id. Only the key itself creates
 * ciphers from its bytes, for envelope.ts.
 *
 * The key id is public: the first 8 bytes of SHA-256 over KEY_ID_LABEL and the key. A sealed file
 * carries it, so opening a file with the wrong key is refused before any decryption.
 *
 * Server-only by use; imported by path with relative .ts specifiers, so scripts run it under
 * plain Node.
 */
import {
	createCipheriv,
	createDecipheriv,
	createHash,
	type CipherGCM,
	type DecipherGCM
} from 'node:crypto';
import { inspect } from 'node:util';
import { BackupError } from './errors.ts';

export const KEY_BYTES = 32;
export const KEY_ID_BYTES = 8;
/** Domain separation for the key id, so it is never the hash of the bare key. */
export const KEY_ID_LABEL = 'performance-coach/backup-key-id/v1\0';

const ALGORITHM = 'aes-256-gcm';
const TAG_BYTES = 16;

/** 32 bytes: 43 characters and one '=' in base64, 43 with an optional '=' in base64url. */
const BASE64 = /^[A-Za-z0-9+/]{43}=$/;
const BASE64URL = /^[A-Za-z0-9_-]{43}=?$/;
/** Any base64 or base64url text, to report how many bytes a wrong-length key decodes to. */
const ANY_BASE64 = /^(?:[A-Za-z0-9+/]+|[A-Za-z0-9_-]+)={0,2}$/;

export class BackupKey {
	readonly #bytes: Buffer;
	/** The key id as 16 lower-case hex characters. */
	readonly id: string;

	/** Use parseBackupKey; the bytes are copied, so the caller may wipe its buffer. */
	constructor(bytes: Uint8Array) {
		if (bytes.length !== KEY_BYTES) {
			throw new BackupError(
				'invalid_key',
				`A backup key is ${KEY_BYTES} bytes, not ${bytes.length}`
			);
		}
		this.#bytes = Buffer.from(bytes);
		this.id = createHash('sha256')
			.update(KEY_ID_LABEL)
			.update(this.#bytes)
			.digest()
			.subarray(0, KEY_ID_BYTES)
			.toString('hex');
	}

	/** The key id's 8 bytes, as an envelope header holds them. */
	idBytes(): Buffer {
		return Buffer.from(this.id, 'hex');
	}

	/** An AES-256-GCM cipher under this key, with a 16-byte tag. */
	cipher(iv: Uint8Array): CipherGCM {
		return createCipheriv(ALGORITHM, this.#bytes, iv, { authTagLength: TAG_BYTES });
	}

	/** An AES-256-GCM decipher under this key, expecting a 16-byte tag. */
	decipher(iv: Uint8Array): DecipherGCM {
		return createDecipheriv(ALGORITHM, this.#bytes, iv, { authTagLength: TAG_BYTES });
	}

	toString(): string {
		return `[BackupKey ${this.id}]`;
	}

	toJSON(): string {
		return this.toString();
	}

	[Symbol.toPrimitive](): string {
		return this.toString();
	}

	[inspect.custom](): string {
		return this.toString();
	}
}

/**
 * Reads a key from its text (surrounding whitespace ignored): exactly 32 bytes, in base64 or
 * base64url, in canonical form. Anything else fails with invalid_key, naming `name` (the variable
 * it came from) and the decoded length, never the text.
 */
export function parseBackupKey(text: string, name: string): BackupKey {
	const trimmed = text.trim();
	if (BASE64.test(trimmed) || BASE64URL.test(trimmed)) {
		const encoding = BASE64.test(trimmed) ? 'base64' : 'base64url';
		const bytes = Buffer.from(trimmed, encoding);
		// The last character carries two spare bits; a non-canonical one would be a second
		// spelling of the same key.
		if (
			bytes.length === KEY_BYTES &&
			bytes.toString(encoding).replace(/=+$/, '') === trimmed.replace(/=+$/, '')
		) {
			const key = new BackupKey(bytes);
			bytes.fill(0);
			return key;
		}
		bytes.fill(0);
		return refuse(name, 'is not canonical base64');
	}
	if (trimmed === '') return refuse(name, 'is empty');
	if (!ANY_BASE64.test(trimmed)) return refuse(name, 'is not base64 or base64url');
	const length = Buffer.byteLength(trimmed.replace(/=+$/, ''), 'base64url');
	return refuse(
		name,
		length === KEY_BYTES ? 'is not canonical base64' : `decodes to ${length} bytes`
	);
}

function refuse(name: string, why: string): never {
	throw new BackupError(
		'invalid_key',
		`${name} must be ${KEY_BYTES} bytes of base64 or base64url; it ${why}`
	);
}
