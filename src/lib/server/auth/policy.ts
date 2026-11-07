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
	recoveryMs: 15 * MINUTE,
	/**
	 * Step-up: adding or removing a passkey, new recovery codes and signing devices out need a
	 * passkey assertion on the session (sign-in, setup or re-authentication) this recent.
	 */
	reauthMs: 5 * MINUTE
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
	/** Failed recovery-code sign-ins, all clients together (a valid code is never refused). */
	'recovery.global': { limit: 20, windowMs: HOUR },
	/** Adding a passkey (options + verification), per session. */
	register: { limit: 20, windowMs: 15 * MINUTE },
	/** Step-up re-authentication (options + verification), per session. */
	reauth: { limit: 20, windowMs: 15 * MINUTE },
	/** Rename/remove passkeys, revoke sessions, regenerate codes, per session. */
	manage: { limit: 60, windowMs: MINUTE },
	/** Sign-out requests, per client. */
	signout: { limit: 30, windowMs: MINUTE },
	/** Email sign-in link requests, per client (ADR 0011). */
	'email.request': { limit: 5, windowMs: 15 * MINUTE },
	/** Email sign-in link requests, all clients together. */
	'email.hourly': { limit: 10, windowMs: HOUR },
	/** Email sign-in links sent per day, all clients (inside Resend's free 100 a day, 3,000 a month). */
	'email.daily': { limit: 20, windowMs: DAY },
	/** Email sign-in link redemptions, per client (tokens are unguessable: this limits noise). */
	'email.verify': { limit: 10, windowMs: 15 * MINUTE }
} as const satisfies Record<string, RateLimitPolicy>;

export type RateLimitBucket = keyof typeof RATE_LIMITS;

/**
 * Counters whose window started over `staleAfterMs` ago (far longer than any window) are deleted
 * on writes: each new window retires up to `batch` of them, so one-off clients cannot grow
 * `auth_rate_limits` without bound and no request pays for more than one small delete.
 */
export const RATE_LIMIT_PRUNE = { staleAfterMs: 2 * DAY, batch: 100 } as const;

/** Email sign-in links (ADR 0011, auth/email-link.ts). */
export const EMAIL_LINK = {
	/** A link works once, within this long of being sent (the table's CHECK caps it at 15 minutes). */
	ttlMs: 15 * MINUTE,
	/**
	 * Hard cap of the session a link creates. Owner decision (open question): the same 90 days as
	 * a passkey session by default; a shorter value (e.g. 14 days) applies only to link sessions.
	 */
	sessionAbsoluteMs: SESSION.absoluteMs,
	/** The send gives up after this long (above Resend's own 10 s timeout), so nothing hangs. */
	sendTimeoutMs: 15_000
} as const;
