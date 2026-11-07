/**
 * Sessions: opaque random tokens in an HttpOnly cookie, only their SHA-256 in Postgres.
 *
 * - Sliding expiry (30 days idle), refreshed at most once a day; absolute cap 90 days.
 * - Revoked or expired sessions are rejected on the next request (no cache).
 * - Signing in (passkey or recovery code) always issues a *new* token and revokes the session the
 *   device presented, so a token planted before sign-in is useless afterwards (rotation).
 * - A `recovery` session lives 15 minutes and can only register a new passkey or sign out.
 * - Signing devices out needs a recent passkey assertion on this session (reauth.ts).
 */
import { createAuthRepository, type SessionKind, type SessionMethod, type SessionRow } from '../db';
import { createEmailLinksRepository } from '../db/repositories/email-links';
import { isUuid } from '../services/ids';
import { recordAuthEvent } from './audit';
import { resolveDeps, type AuthDeps, type AuthRequest } from './context';
import { describeUserAgent } from './devices';
import { AuthError } from './errors';
import { SESSION } from './policy';
import { enforceRateLimit } from './rate-limit';
import { requireRecentAuthentication } from './reauth';
import { generateToken, hashToken } from './tokens';

export interface AuthSession {
	id: string;
	ownerId: string;
	ownerName: string;
	kind: SessionKind;
	expiresAt: Date;
	/** Last passkey assertion on this session (null: none yet). See reauth.ts. */
	reauthenticatedAt: Date | null;
}

export interface IssuedSession {
	/** The cookie value. Shown to nobody else, stored nowhere. */
	token: string;
	session: SessionRow;
}

export interface SessionCheck {
	session: AuthSession;
	/** Set when the sliding expiry moved: the cookie must be re-sent with this expiry. */
	refreshedExpiry?: Date;
}

/** Create a session (inside the caller's transaction) and return its token. */
export async function issueSession(
	input: {
		ownerId: string;
		kind?: SessionKind;
		method: SessionMethod;
		credentialId?: string | null;
		userAgent: string | null;
		/** A user-verified passkey ceremony just established it: it starts out fresh. */
		reauthenticated?: boolean;
		/** Hard cap from now for an owner session (default `SESSION.absoluteMs`). */
		absoluteMs?: number;
	},
	deps: AuthDeps = {}
): Promise<IssuedSession> {
	const { db, now } = resolveDeps(deps);
	const at = now();
	const kind = input.kind ?? 'owner';
	const absolute = new Date(
		at.getTime() +
			(kind === 'recovery' ? SESSION.recoveryMs : (input.absoluteMs ?? SESSION.absoluteMs))
	);
	const idle = new Date(at.getTime() + SESSION.idleMs);
	const token = generateToken();
	const session = await createAuthRepository(db).insertSession({
		ownerId: input.ownerId,
		tokenHash: hashToken(token),
		kind,
		method: input.method,
		credentialId: input.credentialId ?? null,
		createdAt: at,
		lastSeenAt: at,
		expiresAt: idle < absolute ? idle : absolute,
		absoluteExpiresAt: absolute,
		userAgent: describeUserAgent(input.userAgent),
		reauthenticatedAt: input.reauthenticated ? at : null
	});
	return { token, session };
}

/** Revoke the session behind a presented token, if it is still live (rotation, sign-out). */
export async function revokeToken(
	token: string | undefined,
	reason: string,
	deps: AuthDeps = {}
): Promise<SessionRow | null> {
	if (!token) return null;
	const { db, now } = resolveDeps(deps);
	const repo = createAuthRepository(db);
	const live = await repo.findActiveSession(hashToken(token), now());
	if (!live) return null;
	await repo.revokeSession(live.session.id, reason, now());
	return live.session;
}

/**
 * Resolve a cookie token to a live session (one indexed query), sliding its expiry forward at
 * most once a day and its last-seen time at most every 10 minutes.
 */
export async function validateSessionToken(
	token: string | undefined,
	deps: AuthDeps = {}
): Promise<SessionCheck | null> {
	if (!token || token.length > 128) return null;
	const { db, now } = resolveDeps(deps);
	const repo = createAuthRepository(db);
	const at = now();
	const found = await repo.findActiveSession(hashToken(token), at);
	if (!found) return null;
	const { session, owner } = found;

	let expiresAt = session.expiresAt;
	let refreshedExpiry: Date | undefined;
	const sinceRefresh = SESSION.idleMs - (session.expiresAt.getTime() - at.getTime());
	if (session.kind === 'owner' && sinceRefresh >= SESSION.refreshEveryMs) {
		const next = new Date(
			Math.min(at.getTime() + SESSION.idleMs, session.absoluteExpiresAt.getTime())
		);
		if (next > session.expiresAt) {
			expiresAt = next;
			refreshedExpiry = next;
		}
	}
	if (refreshedExpiry || at.getTime() - session.lastSeenAt.getTime() >= SESSION.lastSeenEveryMs) {
		await repo.touchSession(session.id, {
			lastSeenAt: at,
			...(refreshedExpiry ? { expiresAt: refreshedExpiry } : {})
		});
	}

	return {
		session: {
			id: session.id,
			ownerId: owner.id,
			ownerName: owner.displayName,
			kind: session.kind,
			expiresAt,
			reauthenticatedAt: session.reauthenticatedAt
		},
		refreshedExpiry
	};
}

export interface SessionSummary {
	id: string;
	current: boolean;
	/** `recovery`: signed in with a recovery code; it can only add a passkey, for 15 minutes. */
	kind: SessionKind;
	method: SessionMethod;
	/** How it signed in, as Security says it: "Signed in 5 Nov with {signedInWith}". */
	signedInWith: string;
	device: string;
	createdAt: Date;
	lastSeenAt: Date;
	expiresAt: Date;
}

/**
 * Labelled here, not on the page: every method needs one (the Record is exhaustive, so a new
 * method does not type-check without it), and the words cost Security's initial JS nothing.
 */
const SIGNED_IN_WITH: Record<SessionMethod, string> = {
	setup: 'set up',
	passkey: 'passkey',
	recovery: 'recovery code',
	test: 'test session',
	email_link: 'email link'
};

/**
 * Every live session of the owner: this one first, then recovery sign-ins (a recovery code in
 * someone else's hands shows up here, to be signed out), then the rest by last activity.
 */
export async function listSessions(
	session: AuthSession,
	deps: AuthDeps = {}
): Promise<SessionSummary[]> {
	const { db, now } = resolveDeps(deps);
	const rows = await createAuthRepository(db).listActiveSessions(session.ownerId, now());
	const rank = (s: SessionSummary) => (s.current ? 2 : s.kind === 'recovery' ? 1 : 0);
	return rows
		.map((row) => ({
			id: row.id,
			current: row.id === session.id,
			kind: row.kind,
			method: row.method,
			signedInWith: SIGNED_IN_WITH[row.method],
			device: row.userAgent ?? 'Unknown device',
			createdAt: row.createdAt,
			lastSeenAt: row.lastSeenAt,
			expiresAt: row.expiresAt
		}))
		.sort((a, b) => rank(b) - rank(a));
}

/** Revoke one of the owner's other sessions (Security → Sessions). */
export async function revokeSession(
	session: AuthSession,
	sessionId: string,
	request: AuthRequest,
	deps: AuthDeps = {}
): Promise<void> {
	const { db, now } = resolveDeps(deps);
	requireRecentAuthentication(session, now());
	await enforceRateLimit('manage', { session: session.id }, request, { db, now });
	if (sessionId === session.id) {
		throw new AuthError('invalid_input', 'Use Sign out to end this session.');
	}
	const revoked =
		isUuid(sessionId) &&
		(await createAuthRepository(db).revokeSession(sessionId, 'revoked', now(), session.ownerId));
	if (!revoked) throw new AuthError('not_found', 'That session has already ended.');
	await recordAuthEvent(db, request, {
		type: 'session.revoked',
		ownerId: session.ownerId,
		sessionId: session.id,
		detail: { revoked: sessionId }
	});
}

/**
 * "Sign out everywhere else": every session but this one, and every pending email sign-in link
 * (a link already in someone's inbox would otherwise sign another device straight back in).
 * Returns how many sessions ended.
 */
export async function revokeOtherSessions(
	session: AuthSession,
	request: AuthRequest,
	deps: AuthDeps = {}
): Promise<number> {
	const { db, now } = resolveDeps(deps);
	requireRecentAuthentication(session, now());
	await enforceRateLimit('manage', { session: session.id }, request, { db, now });
	const count = await db.transaction(async (tx) => {
		const repo = createAuthRepository(tx);
		// A passkey registration in flight holds its session's row lock and may replace that
		// session with a new one (a recovery upgrade). Lock first, which waits for it, then revoke
		// in a new statement, whose snapshot includes any session it created.
		await repo.lockOtherSessions(session.ownerId, session.id);
		const ended = await repo.revokeOtherSessions(
			session.ownerId,
			session.id,
			'signed_out_elsewhere',
			now()
		);
		await createEmailLinksRepository(tx).revokeLiveLinks(session.ownerId, now());
		return ended;
	});
	await recordAuthEvent(db, request, {
		type: 'session.revoked_others',
		ownerId: session.ownerId,
		sessionId: session.id,
		detail: { count }
	});
	return count;
}

/**
 * Sign out: revoke the presented session (if any). Idempotent. Only a request that ends no
 * session counts against the per-client limit: everyone behind one NAT or Wi-Fi shares that
 * bucket, and filling it must never keep a live session signed in. A token ends its session
 * only once, so skipping the limit for it cannot be used to flood.
 */
export async function signOut(
	token: string | undefined,
	request: AuthRequest,
	deps: AuthDeps = {}
): Promise<void> {
	const { db, now } = resolveDeps(deps);
	const revoked = await revokeToken(token, 'signout', { db, now });
	if (!revoked) {
		await enforceRateLimit('signout', { ip: request.ip }, request, { db, now });
		return;
	}
	await recordAuthEvent(db, request, {
		type: 'signout',
		ownerId: revoked.ownerId,
		sessionId: revoked.id
	});
}
