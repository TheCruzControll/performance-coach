/**
 * Email sign-in links (ADR 0011): ask for a one-time link to the owner's configured address, and
 * redeem it for a full owner session that still needs a passkey for step-up actions.
 *
 * - **Requesting** (`requestSignInLink`) is the work a request triggers after its answer has been
 *   sent, so nothing here can change what the requester sees, and it never throws. It counts the
 *   per-client, hourly and daily limits, then checks the owner and setup, then stores a new link
 *   (only the SHA-256 of a 256-bit token; older live links are revoked) and mails it through a
 *   mailer bound to OWNER_EMAIL. The link is built from the relying party's origin, never from
 *   the request's Host header.
 * - **Redeeming** (`completeEmailSignIn`) consumes the link in the transaction that rotates the
 *   presented session (whatever its kind) and issues the new one, so a link signs in once, also
 *   under concurrent use. Every failure is the same `link_invalid`; the audit says why.
 *
 * No token and no address is ever logged or audited.
 */
import { createAuthRepository, type Executor } from '../db';
import { createEmailLinksRepository } from '../db/repositories/email-links';
import { createMailer, MailError, type Mailer } from '../mail';
import { logger } from '../observability/logger';
import { recordAuthEvent } from './audit';
import { resolveDeps, type AuthDeps, type AuthRequest } from './context';
import type { EmailLinkConfig } from './email-link-config';
import { emailLinkMessage } from './email-link-message';
import { AuthError, isAuthError } from './errors';
import { EMAIL_LINK } from './policy';
import { enforceRateLimit } from './rate-limit';
import { issueSession, revokeToken, type IssuedSession } from './sessions';
import { generateToken, hashToken } from './tokens';

export type EnabledEmailLinkConfig = Extract<EmailLinkConfig, { enabled: true }>;

export interface EmailLinkDeps extends AuthDeps {
	config: EnabledEmailLinkConfig;
	/** Defaults to the configured provider's mailer, bound to `config.ownerEmail`. */
	mailer?: Mailer;
	/** Defaults to `EMAIL_LINK.sendTimeoutMs`. */
	sendTimeoutMs?: number;
}

/** What a request led to; for tests and logs only, never for the requester. */
export type EmailLinkRequestOutcome = 'sent' | 'rate_limited' | 'refused' | 'send_failed' | 'error';

/** `<origin>/?link#t=<token>`: the fragment never reaches a server, a log or a Referer. */
export function emailLinkUrl(origin: string, token: string): string {
	return `${origin}/?link#t=${token}`;
}

/** A link token as generateToken makes it: 32 bytes, base64url, 43 characters. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

const INVALID = 'This sign-in link no longer works. Ask for a new one, or use your passkey.';

function mailerFor(config: EnabledEmailLinkConfig): Mailer {
	return config.provider === 'resend'
		? createMailer({
				provider: 'resend',
				apiKey: config.apiKey,
				from: config.from,
				to: config.ownerEmail
			})
		: createMailer({ provider: 'test', from: config.from, to: config.ownerEmail });
}

/** The send, given up after `ms` so a hanging provider cannot hold the work open. */
async function sendWithin(mailer: Mailer, message: Parameters<Mailer['send']>[0], ms: number) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new MailError('timeout', { timeoutMs: ms })), ms);
	});
	try {
		return await Promise.race([mailer.send(message), timeout]);
	} finally {
		clearTimeout(timer);
	}
}

/** Only the code, status and provider error name of a failed send (never its message). */
function sendFailure(err: unknown): Record<string, unknown> {
	if (!(err instanceof MailError)) return { code: 'unknown' };
	return {
		code: err.code,
		...(err.status !== undefined ? { status: err.status } : {}),
		...(err.providerError ? { providerError: err.providerError } : {})
	};
}

/**
 * Send the owner a sign-in link, if the limits, the owner and the origin allow it. Runs after
 * the response; resolves in every case (a top-level catch logs and audits).
 */
export async function requestSignInLink(
	request: AuthRequest,
	deps: EmailLinkDeps
): Promise<EmailLinkRequestOutcome> {
	const { db, now } = resolveDeps(deps);
	const refuse = async (reason: string, ownerId: string | null = null) => {
		await recordAuthEvent(db, request, {
			type: 'email_link.refused',
			ownerId,
			detail: { stage: 'request', reason }
		});
		return 'refused' as const;
	};
	try {
		try {
			// Per client first, so one client's flood never reaches the global counters.
			await enforceRateLimit('email.request', { ip: request.ip }, request, { db, now });
			await enforceRateLimit('email.hourly', 'global', request, { db, now });
			await enforceRateLimit('email.daily', 'global', request, { db, now });
		} catch (err) {
			// The limit already wrote its one audit row for this window.
			if (isAuthError(err) && err.code === 'rate_limited') return 'rate_limited';
			throw err;
		}
		const origin = request.rp?.origin;
		if (!origin) return await refuse('wrong_origin');
		const owner = await createAuthRepository(db).getOwner();
		if (!owner) return await refuse('no_owner');
		if (!owner.setupCompletedAt) return await refuse('setup_open', owner.id);

		const token = generateToken();
		const link = await createEmailLinksRepository(db).issueLink(
			owner.id,
			hashToken(token),
			now(),
			EMAIL_LINK.ttlMs
		);
		await recordAuthEvent(db, request, {
			type: 'email_link.requested',
			ownerId: owner.id,
			detail: { link: link.id }
		});
		const mailer = deps.mailer ?? mailerFor(deps.config);
		try {
			const sent = await sendWithin(
				mailer,
				{ ...emailLinkMessage(emailLinkUrl(origin, token)), idempotencyKey: link.id },
				deps.sendTimeoutMs ?? EMAIL_LINK.sendTimeoutMs
			);
			await recordAuthEvent(db, request, {
				type: 'email_link.sent',
				ownerId: owner.id,
				detail: { link: link.id, provider: mailer.provider, messageId: sent.id }
			});
			return 'sent';
		} catch (err) {
			await recordAuthEvent(db, request, {
				type: 'email_link.send_failed',
				ownerId: owner.id,
				detail: { link: link.id, provider: mailer.provider, ...sendFailure(err) }
			});
			return 'send_failed';
		}
	} catch (err) {
		logger.error('email sign-in link request failed', { err });
		await refuse('error');
		return 'error';
	}
}

/**
 * Redeem a link for a full owner session (method `email_link`, no step-up freshness), revoking
 * the session the browser presented, whatever its kind. Throws `link_invalid` for every bad link.
 */
export async function completeEmailSignIn(
	token: unknown,
	presentedToken: string | undefined,
	request: AuthRequest,
	deps: AuthDeps = {}
): Promise<IssuedSession> {
	const { db, now } = resolveDeps(deps);
	await enforceRateLimit('email.verify', { ip: request.ip }, request, { db, now });

	const at = now();
	const hash = typeof token === 'string' && TOKEN_SHAPE.test(token) ? hashToken(token) : null;
	const result = hash
		? await db.transaction(async (tx) => {
				const links = createEmailLinksRepository(tx);
				const link = await links.consumeLink(hash, at);
				if (!link) return null;
				await revokeToken(presentedToken, 'rotated', { db: tx, now });
				const issued = await issueSession(
					{
						ownerId: link.ownerId,
						kind: 'owner',
						method: 'email_link',
						userAgent: request.userAgent,
						reauthenticated: false,
						absoluteMs: EMAIL_LINK.sessionAbsoluteMs
					},
					{ db: tx, now }
				);
				await links.attachSession(link.id, issued.session.id);
				return { ...issued, link };
			})
		: null;

	if (!result) {
		await recordRefusal(db, hash, at, request);
		throw new AuthError('link_invalid', INVALID);
	}
	await recordAuthEvent(db, request, {
		type: 'email_link.used',
		ownerId: result.link.ownerId,
		sessionId: result.session.id,
		detail: { link: result.link.id }
	});
	return { token: result.token, session: result.session };
}

/** Why a link was refused, for the audit only: expired, or refused with its reason. */
async function recordRefusal(
	db: Executor,
	hash: string | null,
	at: Date,
	request: AuthRequest
): Promise<void> {
	if (!hash) {
		await recordAuthEvent(db, request, {
			type: 'email_link.refused',
			detail: { stage: 'redeem', reason: 'malformed' }
		});
		return;
	}
	const owner = await createAuthRepository(db).getOwner();
	if (owner && !owner.setupCompletedAt) {
		await recordAuthEvent(db, request, {
			type: 'email_link.refused',
			ownerId: owner.id,
			detail: { stage: 'redeem', reason: 'setup_open' }
		});
		return;
	}
	const status = await createEmailLinksRepository(db).linkStatus(hash, at);
	await recordAuthEvent(db, request, {
		type: status === 'expired' ? 'email_link.expired' : 'email_link.refused',
		ownerId: owner?.id ?? null,
		detail:
			status === 'expired'
				? { stage: 'redeem' }
				: { stage: 'redeem', reason: status === 'live' ? 'unknown' : status }
	});
}
