/**
 * The one redactor every log line and every `app_errors` row passes through. It removes the exact
 * values of the server's secret variables, credential-shaped text (URL passwords, Bearer tokens,
 * provider keys, PEM keys), email addresses and URL query strings, and caps long text. It reads
 * `process.env` on every call, so a test can stub a variable.
 */

export const REDACTED = '[redacted]';
export const EMAIL_MASK = '[email]';
/** Cap for any logged or recorded string. */
export const MAX_TEXT = 2048;
/** Cap for a stack trace (matches the client report's 8 000-character limit). */
export const MAX_STACK = 8192;

/** Server variables whose exact values are removed from any text. */
export const SECRET_VARIABLES = [
	'DATABASE_URL',
	'DATABASE_URL_UNPOOLED',
	'ANTHROPIC_API_KEY',
	'RESEND_API_KEY',
	'CRON_SECRET',
	'BACKUP_ENCRYPTION_KEY',
	'BLOB_READ_WRITE_TOKEN',
	'OWNER_SETUP_TOKEN_HASH',
	'PGPASSWORD',
	'OWNER_EMAIL'
] as const;

/** A field whose value is a credential, matched on the end of its key, case-insensitive. */
export const SECRET_KEY =
	/(?:authorization|cookie|password|passphrase|secret|token|api[-_]?key|private[-_]?key)$/i;

/** A value shorter than this is too likely to be a common word to replace in text. */
const MIN_SECRET_LENGTH = 8;
/** How deep `redactValue` walks; deeper values become '[depth]'. */
const MAX_DEPTH = 8;
/** Objects and arrays one redactValue call walks at most: shared references can fan out. */
export const MAX_NODES = 5000;
/**
 * The pattern steps see at most this many times the cap. Some patterns are quadratic on long runs
 * of characters, so a long text is cut before them; the exact-value step still sees all of it.
 */
const SCAN_FACTOR = 4;

const POSTGRES_PASSWORD = /(postgres(?:ql)?:\/\/[^\s:@/'"`]+:)[^\s@/'"`]+@/g;
const BEARER = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;
const ANTHROPIC_KEY = /sk-ant-[A-Za-z0-9_-]{8,}/g;
const RESEND_KEY = /(?<![A-Za-z0-9_])re_[A-Za-z0-9]{4,}_[A-Za-z0-9_-]{8,}/g;
const VERCEL_BLOB_TOKEN = /vercel_blob_rw_[A-Za-z0-9_]+/g;
const NEON_PASSWORD = /(?<![A-Za-z0-9_])npg_[A-Za-z0-9]{12,}/g;
const PEM_PRIVATE_KEY =
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const URL_QUERY = /(https?:\/\/[^\s?#"'`<>()]+)\?[^\s#"'`<>()]*/g;
// The lookbehind lets a match start only at the start of a run, which keeps this step linear.
const EMAIL = /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** The exact values of the secret variables set on this process, longest first. */
function secretValues(): string[] {
	return SECRET_VARIABLES.map((name) => process.env[name]?.trim() ?? '')
		.filter((value) => value.length >= MIN_SECRET_LENGTH)
		.sort((a, b) => b.length - a.length);
}

/**
 * Redact one string and cap it at `max` characters. The exact secret values are removed from the
 * whole text first, then the text is cut to `max * SCAN_FACTOR` before the patterns run, and the
 * cap comes last, so a secret cut at the boundary cannot half-survive. The "more chars" count is
 * measured on the scanned window, so for a text longer than that window it is an undercount.
 */
export function redactText(text: string, max: number = MAX_TEXT): string {
	let result = text;
	for (const value of secretValues()) result = result.split(value).join(REDACTED);
	result = result.slice(0, max * SCAN_FACTOR);
	// Before the email step, so `user:[redacted]@host.tld` is never read as an email address.
	result = result.replace(POSTGRES_PASSWORD, `$1${REDACTED}@`);
	result = result.replace(BEARER, `$1${REDACTED}`);
	result = result.replace(ANTHROPIC_KEY, REDACTED);
	result = result.replace(RESEND_KEY, REDACTED);
	result = result.replace(VERCEL_BLOB_TOKEN, REDACTED);
	result = result.replace(NEON_PASSWORD, REDACTED);
	result = result.replace(PEM_PRIVATE_KEY, REDACTED);
	result = result.replace(URL_QUERY, `$1?${REDACTED}`);
	result = result.replace(EMAIL, EMAIL_MASK);
	if (result.length > max) {
		return `${result.slice(0, max)}… [${result.length - max} more chars]`;
	}
	return result;
}

function isPlainObject(value: object): boolean {
	const proto = Object.getPrototypeOf(value) as unknown;
	return proto === Object.prototype || proto === null;
}

/** The arrays and plain objects on the path from the root to the value being walked. */
const onPath = new WeakSet<object>();

function walk(
	value: unknown,
	key: string | undefined,
	depth: number,
	budget: { left: number }
): unknown {
	if (depth > MAX_DEPTH) return '[depth]';
	if (
		key !== undefined &&
		SECRET_KEY.test(key) &&
		(typeof value === 'string' || (typeof value === 'object' && value !== null))
	) {
		return REDACTED;
	}
	if (typeof value === 'string') {
		return redactText(value, key === 'stack' ? MAX_STACK : MAX_TEXT);
	}
	if (typeof value === 'object' && value !== null) {
		if (!Array.isArray(value) && !isPlainObject(value)) return value;
		// Already on this path: a cycle. Shared references that are not on the path are walked again.
		if (onPath.has(value)) return '[circular]';
		if (budget.left-- <= 0) return '[truncated]';
		onPath.add(value);
		try {
			if (Array.isArray(value)) {
				return value.map((item) => walk(item, key, depth + 1, budget));
			}
			return Object.fromEntries(
				Object.entries(value).map(([entryKey, entry]) => [
					entryKey,
					walk(entry, entryKey, depth + 1, budget)
				])
			);
		} finally {
			onPath.delete(value);
		}
	}
	return value;
}

/**
 * Redact a value of any shape: a secret-named field becomes REDACTED (its non-string scalars are
 * kept, so a `hasToken: true` flag survives), and every string is redacted by `redactText`.
 */
export function redactValue(value: unknown): unknown {
	return walk(value, undefined, 0, { left: MAX_NODES });
}

/** A path without its query string or fragment: '/setup?token=x#y' -> '/setup'; '' -> '/'. */
export function pathOnly(path: string): string {
	return path.split(/[?#]/, 1)[0] || '/';
}
