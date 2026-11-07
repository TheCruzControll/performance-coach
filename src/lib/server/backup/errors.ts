/**
 * Why a backup could not be sealed, opened or read. Every code is a refusal: nothing is
 * released, written or restored after one.
 *
 * - `invalid_key`: the key text is not 32 bytes of base64 or base64url
 * - `not_a_backup`: the bytes do not start with the envelope's magic
 * - `unsupported_format`: an envelope format, algorithm or archive version this code cannot read
 * - `wrong_key`: the file was sealed with another key (its key id differs)
 * - `tampered`: the GCM tag does not verify, so some byte changed or the file was cut short
 * - `too_large`: the file, or the archive inside it, is over its cap
 * - `truncated`: the envelope or the archive ends before its last part
 * - `malformed`: a control line, or the order of the lines, is not the format's
 * - `trailing_data`: a line follows the trailer
 * - `count_mismatch`: a table's row count differs from the trailer's
 * - `checksum_mismatch`: a table's digest, or the digest of the whole archive, differs
 */
export type BackupErrorCode =
	| 'invalid_key'
	| 'not_a_backup'
	| 'unsupported_format'
	| 'wrong_key'
	| 'tampered'
	| 'too_large'
	| 'truncated'
	| 'malformed'
	| 'trailing_data'
	| 'count_mismatch'
	| 'checksum_mismatch';

/**
 * A refusal with its code. Messages name variables, tables, paths, lengths and caps only, never
 * a key, a row or any other value from the file, and there is no `cause`, so the error is safe to
 * log whole.
 */
export class BackupError extends Error {
	readonly code: BackupErrorCode;

	constructor(code: BackupErrorCode, message: string) {
		super(message);
		this.name = 'BackupError';
		this.code = code;
	}
}

/** Whether `error` is a BackupError, with `code` when given. */
export function isBackupError(error: unknown, code?: BackupErrorCode): error is BackupError {
	return error instanceof BackupError && (code === undefined || error.code === code);
}
