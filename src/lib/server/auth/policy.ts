/**
 * Auth timing and abuse limits in one place (documented in docs/security.md).
 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const SESSION = {
	/** Idle lifetime: a session unused for this long expires. */
	idleMs: 30 * DAY,
	/** Sliding expiry is pushed forward at most this often (one write a day, not per request). */
	refreshEveryMs: DAY,
	/** Hard cap from sign-in, however active the session is. */
	absoluteMs: 90 * DAY,
	/** `last_seen_at` resolution: written at most this often between refreshes. */
	lastSeenEveryMs: 10 * MINUTE,
	/** A recovery session exists only to register a new passkey. */
	recoveryMs: 15 * MINUTE
} as const;

/** WebAuthn ceremonies: the browser times out at `ceremonyMs`, the challenge a little later. */
export const CHALLENGE = {
	ceremonyMs: 3 * MINUTE,
	ttlMs: 5 * MINUTE
} as const;

export interface RateLimitPolicy {
	limit: number;
	windowMs: number;
}

/**
 * Fixed-window limits per bucket, counted in Postgres (shared by every server instance).
 * `ip` buckets key on the client address; `session` buckets on the session id; `global` on
 * nothing (a ceiling for the whole deployment, for guessable-in-principle secrets).
 */
export const RATE_LIMITS = {
	/** Requesting sign-in options (also creates a challenge row). */
	'signin.options': { limit: 30, windowMs: MINUTE },
	/** Submitting a passkey assertion. */
	'signin.verify': { limit: 10, windowMs: MINUTE },
	/** First-run setup: options and verification, and every token check. */
	setup: { limit: 10, windowMs: 15 * MINUTE },
	/** Recovery-code sign-in, per client. */
	recovery: { limit: 5, windowMs: 15 * MINUTE },
	/** Recovery-code sign-in, all clients together. */
	'recovery.global': { limit: 20, windowMs: HOUR },
	/** Adding a passkey (options + verification), per session. */
	register: { limit: 20, windowMs: 15 * MINUTE },
	/** Rename/remove passkeys, revoke sessions, regenerate codes, per session. */
	manage: { limit: 60, windowMs: MINUTE },
	/** Sign-out requests, per client. */
	signout: { limit: 30, windowMs: MINUTE }
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitBucket = keyof typeof RATE_LIMITS;
