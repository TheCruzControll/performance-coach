/**
 * The secret formats every scanner shares: scripts/secrets-scan.ts (the tracked tree and git
 * history) and scripts/client-secret-scan.ts (what the browser downloads). Each format is
 * anchored on the provider's whole shape, never a bare prefix, so the app's own identifiers
 * (exercises_measure_ck) and the documented placeholders (KNOWN_PLACEHOLDERS) are not reported.
 * A finding carries the matched value so it can be fingerprinted; reports print only `mask`.
 */
import { createHash } from 'node:crypto';

export interface SecretFormat {
	id: string;
	label: string;
	/** Global, so every occurrence is found; the secret is group 1 when the format has one. */
	pattern: RegExp;
	/** A further test the matched value must pass (e.g. it must look random). */
	accept?: (value: string) => boolean;
}

/** Not preceded by an identifier character, so `measure_ck` never starts an `re_` key. */
const START = '(?<![A-Za-z0-9_])';

/** Bits of Shannon entropy per character. */
export function entropy(value: string): number {
	const counts = new Map<string, number>();
	for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
	let bits = 0;
	for (const n of counts.values()) bits -= (n / value.length) * Math.log2(n / value.length);
	return bits;
}

/**
 * Values that look random but are not secrets: UUIDs, git SHAs, SRI hashes, and a reference to
 * another variable (process.env.E2E_CRON_SECRET).
 */
const NOT_SECRET = [
	/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+$/,
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
	/^[0-9a-f]{40}$/i,
	/^sha(?:256|384|512)-[A-Za-z0-9+/]+=*$/
];

/** Minimum length and entropy of a value assigned to a secret-named variable. */
export const MIN_ASSIGNED_LENGTH = 24;
export const MIN_ASSIGNED_ENTROPY = 3.5;

/** Looks like a generated key: long, letters and digits, high entropy, not a public hash. */
export function looksRandom(value: string): boolean {
	return (
		value.length >= MIN_ASSIGNED_LENGTH &&
		/[A-Za-z]/.test(value) &&
		/\d/.test(value) &&
		entropy(value) >= MIN_ASSIGNED_ENTROPY &&
		!NOT_SECRET.some((re) => re.test(value))
	);
}

/** Variables named like a secret without a _KEY, _SECRET, _TOKEN or _PASSWORD suffix. */
export const NAMED_SECRET_VARIABLES = ['OWNER_SETUP_TOKEN_HASH', 'PGPASSWORD'] as const;

/** A password that is an interpolation or a redaction, not a value: ${…}, $1, ***, …, <pw>. */
const NOT_A_PASSWORD = /^(?:\$|\*+$|…|<|\[|%s$)/;

/** The provider formats: each one alone is a credential, wherever it appears. */
export const PROVIDER_FORMATS: readonly SecretFormat[] = [
	{
		id: 'anthropic',
		label: 'an sk-ant- API key',
		pattern: /(sk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{20,})/g
	},
	{
		id: 'resend',
		label: 'a Resend re_ API key',
		pattern: new RegExp(`${START}(re_[A-Za-z0-9]{4,}_[A-Za-z0-9_-]{8,})`, 'g')
	},
	{
		id: 'vercel-blob',
		label: 'a Vercel Blob read-write token',
		pattern: /(vercel_blob_rw_[A-Za-z0-9]+_[A-Za-z0-9]{6,})/g
	},
	{
		id: 'neon',
		label: 'a Neon npg_ password',
		pattern: new RegExp(`${START}(npg_[A-Za-z0-9]{12,})(?![A-Za-z0-9_])`, 'g')
	},
	{
		id: 'pem',
		label: 'a PEM private key',
		pattern: /(-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----\s*[A-Za-z0-9+/=]{0,64})/g
	},
	{
		id: 'postgres-url',
		label: 'a Postgres URL with a password',
		pattern: /postgres(?:ql)?:\/\/([^\s:@/'"`]+:[^\s@/'"`]+)@/g,
		accept: (value) => !NOT_A_PASSWORD.test(value.slice(value.indexOf(':') + 1))
	}
];

/** Formats that need context a minified bundle lacks, so only the repository scan uses them. */
export const CONTEXT_FORMATS: readonly SecretFormat[] = [
	{
		id: 'bearer',
		label: 'a Bearer token literal',
		pattern: /Bearer\s+([A-Za-z0-9._~+/=-]{20,})/g
	},
	{
		id: 'assigned',
		label: 'a random value assigned to a secret-named variable',
		pattern: new RegExp(
			`${START}(?:[A-Z][A-Z0-9_]*_(?:KEY|SECRET|TOKEN|PASSWORD)|${NAMED_SECRET_VARIABLES.join('|')})` +
				`["']?\\s*[:=]\\s*["'\`]?([A-Za-z0-9+/_.=-]{${MIN_ASSIGNED_LENGTH},})`,
			'g'
		),
		accept: looksRandom
	}
];

export const SECRET_FORMATS: readonly SecretFormat[] = [...PROVIDER_FORMATS, ...CONTEXT_FORMATS];

export interface Placeholder {
	value: string;
	/** equals: the whole value; prefix: its start; password: a Postgres URL's password. */
	kind: 'equals' | 'prefix' | 'password';
	reason: string;
}

/** Values that look like a secret and are documented stand-ins; never a real credential. */
export const KNOWN_PLACEHOLDERS: readonly Placeholder[] = [
	{ value: 'postgres:postgres', kind: 'equals', reason: 'the CI service container superuser' },
	{ value: 'coach:coach', kind: 'equals', reason: 'the local and CI application role' },
	{ value: 'coach_app:coach_app', kind: 'equals', reason: 'the local runtime role' },
	{ value: 'u:p', kind: 'equals', reason: 'a URL-parsing test fixture' },
	{ value: 'user:pass', kind: 'equals', reason: 'the documented Neon URL shape' },
	{ value: 'p%40ss', kind: 'password', reason: 'the percent-encoding test fixture' },
	{ value: 're_example_not_a_real_key', kind: 'equals', reason: '.env.example’s Resend stand-in' },
	{
		value: 'sk-ant-api03-Zx9_yW8-vU7tS6rQ5pO4nM3lK2',
		kind: 'equals',
		reason: 'M5’s planted key in client-secret-scan.test.ts'
	},
	{ value: 're_e2e_canary_', kind: 'prefix', reason: 'M2X’s per-run e2e Resend canary' }
];

export function isPlaceholder(value: string): boolean {
	return KNOWN_PLACEHOLDERS.some((p) =>
		p.kind === 'equals'
			? value === p.value
			: p.kind === 'prefix'
				? value.startsWith(p.value)
				: value.endsWith(`:${p.value}`)
	);
}

export interface SecretHit {
	format: SecretFormat;
	value: string;
	/** Offset of the value in the scanned text. */
	index: number;
}

/**
 * Every secret in `text`, placeholders left out unless `placeholders` is false (a client bundle
 * must hold none, not even a stand-in). A span matched by an earlier format is not reported
 * again by a later one (a token assigned to BLOB_READ_WRITE_TOKEN is one finding).
 */
export function findSecrets(
	text: string,
	formats: readonly SecretFormat[] = SECRET_FORMATS,
	{ placeholders = true } = {}
): SecretHit[] {
	const hits: SecretHit[] = [];
	for (const format of formats) {
		for (const match of text.matchAll(format.pattern)) {
			const value = (match[1] ?? match[0]).trimEnd();
			const index = match.index + match[0].indexOf(value);
			if (format.accept && !format.accept(value)) continue;
			if (placeholders && isPlaceholder(value)) continue;
			const end = index + value.length;
			if (hits.some((h) => index < h.index + h.value.length && h.index < end)) continue;
			hits.push({ format, value, index });
		}
	}
	return hits.sort((a, b) => a.index - b.index);
}

/** A stable id for a secret value that does not reveal it (the allowlist's key). */
export function fingerprint(value: string): string {
	return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/** The value as a report may print it: its first characters and its length. */
export function mask(value: string): string {
	return `${value.slice(0, Math.min(6, Math.floor(value.length / 4)))}… (${value.length} chars)`;
}
