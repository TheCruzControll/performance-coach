/**
 * Authentication tables (M2): the single owner, their passkeys, sessions, recovery codes,
 * WebAuthn challenges, used setup tokens, an audit log and DB-backed rate-limit counters. See
 * docs/security.md.
 *
 * Secrets are never stored: sessions, recovery codes and used setup tokens keep only a SHA-256
 * of a high-entropy random value; passkeys keep only the public key.
 */
import { sql } from 'drizzle-orm';
import {
	bigint,
	boolean,
	check,
	customType,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid
} from 'drizzle-orm/pg-core';

/** Postgres `bytea` <-> Uint8Array (node-postgres returns a Buffer). */
const bytea = customType<{ data: Uint8Array<ArrayBuffer>; driverData: Buffer }>({
	dataType: () => 'bytea',
	toDriver: (value) => Buffer.from(value),
	fromDriver: (value) => new Uint8Array(value)
});

const inList = (column: string, values: readonly string[]) =>
	sql.raw(`${column} in (${values.map((v) => `'${v}'`).join(', ')})`);

/** Exactly one owner can exist: `singleton` is always true and unique. */
export const owners = pgTable(
	'owners',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		singleton: boolean('singleton').notNull().default(true),
		displayName: text('display_name').notNull(),
		/** WebAuthn user handle (random, base64url): links discoverable passkeys to the owner. */
		webauthnUserId: text('webauthn_user_id').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		/** Set when the first passkey is registered; first-run setup is closed from then on. */
		setupCompletedAt: timestamp('setup_completed_at', { withTimezone: true })
	},
	(t) => [
		uniqueIndex('owners_singleton_uq').on(t.singleton),
		uniqueIndex('owners_webauthn_user_id_uq').on(t.webauthnUserId),
		check('owners_singleton_ck', sql`${t.singleton}`),
		check('owners_display_name_ck', sql`char_length(${t.displayName}) between 1 and 64`)
	]
);

/**
 * SHA-256 (hex) of every setup token that has completed a setup. A token works once:
 * `pnpm auth:reset-owner` reopens setup but keeps these rows, so an old link (it sits in request
 * logs) stays refused even while its hash is still configured, and a reset needs a new token.
 */
export const usedSetupTokens = pgTable(
	'used_setup_tokens',
	{
		tokenHash: text('token_hash').primaryKey(),
		usedAt: timestamp('used_at', { withTimezone: true }).notNull().defaultNow()
	},
	(t) => [check('used_setup_tokens_token_hash_ck', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`)]
);

export const CREDENTIAL_DEVICE_TYPES = ['singleDevice', 'multiDevice'] as const;

export const passkeyCredentials = pgTable(
	'passkey_credentials',
	{
		/** Credential ID as the authenticator reports it (base64url). */
		id: text('id').primaryKey(),
		ownerId: uuid('owner_id')
			.notNull()
			.references(() => owners.id, { onDelete: 'cascade' }),
		publicKey: bytea('public_key').notNull(),
		/** Signature counter; 0 for authenticators that do not count (most synced passkeys). */
		counter: bigint('counter', { mode: 'number' }).notNull().default(0),
		transports: text('transports')
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		deviceType: text('device_type').$type<(typeof CREDENTIAL_DEVICE_TYPES)[number]>().notNull(),
		backedUp: boolean('backed_up').notNull(),
		aaguid: text('aaguid'),
		nickname: text('nickname').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		lastUsedAt: timestamp('last_used_at', { withTimezone: true })
	},
	(t) => [
		index('passkey_credentials_owner_idx').on(t.ownerId, t.createdAt),
		check('passkey_credentials_device_type_ck', inList('device_type', CREDENTIAL_DEVICE_TYPES)),
		check('passkey_credentials_nickname_ck', sql`char_length(${t.nickname}) between 1 and 64`),
		check('passkey_credentials_counter_ck', sql`${t.counter} >= 0`)
	]
);

/**
 * `owner`: a full session. `recovery`: granted by a recovery code; it may only register a new
 * passkey (then it is rotated into an owner session) or sign out.
 */
export const SESSION_KINDS = ['owner', 'recovery'] as const;
export type SessionKind = (typeof SESSION_KINDS)[number];

export const SESSION_METHODS = ['setup', 'passkey', 'recovery', 'test'] as const;
export type SessionMethod = (typeof SESSION_METHODS)[number];

export const authSessions = pgTable(
	'auth_sessions',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		ownerId: uuid('owner_id')
			.notNull()
			.references(() => owners.id, { onDelete: 'cascade' }),
		/** SHA-256 (hex) of the opaque cookie token. The token itself is never stored. */
		tokenHash: text('token_hash').notNull(),
		kind: text('kind').$type<SessionKind>().notNull().default('owner'),
		/** How the session was established. */
		method: text('method').$type<SessionMethod>().notNull(),
		/** Passkey used to sign in (null after removal, or for setup/recovery/test). */
		credentialId: text('credential_id').references(() => passkeyCredentials.id, {
			onDelete: 'set null'
		}),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
		/** Sliding expiry (refreshed at most once a day), never beyond `absoluteExpiresAt`. */
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
		absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
		/** e.g. "Safari on iPhone" — a summary, not the raw User-Agent. */
		userAgent: text('user_agent'),
		/**
		 * Last user-verified passkey assertion on this session: sign-in, setup, the passkey that
		 * finished a recovery, or a step-up. Sensitive Security actions need it to be recent.
		 */
		reauthenticatedAt: timestamp('reauthenticated_at', { withTimezone: true }),
		revokedAt: timestamp('revoked_at', { withTimezone: true }),
		revokedReason: text('revoked_reason')
	},
	(t) => [
		uniqueIndex('auth_sessions_token_hash_uq').on(t.tokenHash),
		index('auth_sessions_owner_active_idx')
			.on(t.ownerId, t.lastSeenAt.desc())
			.where(sql`${t.revokedAt} is null`),
		check('auth_sessions_kind_ck', inList('kind', SESSION_KINDS)),
		check('auth_sessions_method_ck', inList('method', SESSION_METHODS)),
		check('auth_sessions_token_hash_ck', sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`),
		check('auth_sessions_expiry_ck', sql`${t.expiresAt} <= ${t.absoluteExpiresAt}`)
	]
);

export const recoveryCodes = pgTable(
	'recovery_codes',
	{
		id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
		ownerId: uuid('owner_id')
			.notNull()
			.references(() => owners.id, { onDelete: 'cascade' }),
		/** SHA-256 (hex) of the normalised code. */
		codeHash: text('code_hash').notNull(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		/** Burned: a used code can never be used again. */
		usedAt: timestamp('used_at', { withTimezone: true })
	},
	(t) => [
		uniqueIndex('recovery_codes_code_hash_uq').on(t.codeHash),
		index('recovery_codes_owner_idx').on(t.ownerId),
		check('recovery_codes_code_hash_ck', sql`${t.codeHash} ~ '^[0-9a-f]{64}$'`)
	]
);

export const CHALLENGE_PURPOSES = ['setup', 'authenticate', 'register', 'reauthenticate'] as const;
export type ChallengePurpose = (typeof CHALLENGE_PURPOSES)[number];

/** Short-lived, single-use WebAuthn challenges, each bound to one purpose (and session). */
export const webauthnChallenges = pgTable(
	'webauthn_challenges',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		/** base64url, as sent to the browser and echoed back in clientDataJSON. */
		challenge: text('challenge').notNull(),
		purpose: text('purpose').$type<ChallengePurpose>().notNull(),
		/** RP ID the options were issued for: verification must use the same. */
		rpId: text('rp_id').notNull(),
		/** For `register` and `reauthenticate`: the session that asked (it cannot move to another). */
		sessionId: uuid('session_id').references(() => authSessions.id, { onDelete: 'cascade' }),
		/** Purpose-specific data, e.g. the owner name chosen during setup. */
		data: jsonb('data').$type<Record<string, unknown>>(),
		createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
		expiresAt: timestamp('expires_at', { withTimezone: true }).notNull()
	},
	(t) => [
		uniqueIndex('webauthn_challenges_challenge_uq').on(t.challenge),
		index('webauthn_challenges_expires_idx').on(t.expiresAt),
		check('webauthn_challenges_purpose_ck', inList('purpose', CHALLENGE_PURPOSES))
	]
);

export const AUTH_EVENT_TYPES = [
	'setup.completed',
	'setup.failed',
	'signin.succeeded',
	'signin.failed',
	'passkey.added',
	'passkey.renamed',
	'passkey.removed',
	'recovery.used',
	'recovery.failed',
	'recovery.regenerated',
	'session.revoked',
	'session.revoked_others',
	'reauth.succeeded',
	'reauth.failed',
	'signout',
	'rate_limited',
	'owner.reset'
] as const;
export type AuthEventType = (typeof AUTH_EVENT_TYPES)[number];

/** Append-only audit log of everything security-relevant. */
export const authEvents = pgTable(
	'auth_events',
	{
		id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
		occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
		type: text('type').$type<AuthEventType>().notNull(),
		/** Kept (as null) if the owner is ever reset: the audit trail outlives the account. */
		ownerId: uuid('owner_id').references(() => owners.id, { onDelete: 'set null' }),
		sessionId: uuid('session_id'),
		credentialId: text('credential_id'),
		requestId: text('request_id'),
		/** Client address as the platform reports it (for investigating failed attempts). */
		ip: text('ip'),
		userAgent: text('user_agent'),
		detail: jsonb('detail').$type<Record<string, unknown>>()
	},
	(t) => [
		index('auth_events_occurred_at_idx').on(t.occurredAt.desc()),
		index('auth_events_type_idx').on(t.type, t.occurredAt.desc()),
		check('auth_events_type_ck', inList('type', AUTH_EVENT_TYPES))
	]
);

/** Fixed-window counters, one row per bucket key (e.g. `signin:ip:203.0.113.7`). */
export const authRateLimits = pgTable(
	'auth_rate_limits',
	{
		key: text('key').primaryKey(),
		windowStart: timestamp('window_start', { withTimezone: true }).notNull(),
		count: integer('count').notNull()
	},
	(t) => [index('auth_rate_limits_window_idx').on(t.windowStart)]
);
