/**
 * Email sign-in links end to end on real Postgres (ADR 0011): requesting one (limits, the owner
 * and setup check, the mail to the configured address only, the audit), redeeming it (once,
 * within 15 minutes, newest only, atomically) and the step-up wall a link session still meets.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import pg, { type PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetOwnerAuth } from '../../../scripts/auth-reset-owner';
import {
	authEvents,
	authSessions,
	createAuthRepository,
	emailSignInLinks,
	type AuthEventType,
	type Executor
} from '../../../src/lib/server/db';
import { createEmailLinksRepository } from '../../../src/lib/server/db/repositories/email-links';
import { MailError, testOutbox, type Mailer } from '../../../src/lib/server/mail';
import { setLogLevel } from '../../../src/lib/server/observability/logger';
import {
	completeEmailSignIn,
	requestSignInLink,
	type EmailLinkDeps,
	type EnabledEmailLinkConfig
} from '../../../src/lib/server/auth/email-link';
import {
	beginPasskeyRegistration,
	completePasskeyRegistration,
	removePasskey,
	renamePasskey
} from '../../../src/lib/server/auth/passkeys';
import { EMAIL_LINK, RATE_LIMITS, SESSION } from '../../../src/lib/server/auth/policy';
import {
	beginReauthentication,
	completeReauthentication
} from '../../../src/lib/server/auth/reauth';
import { redeemRecoveryCode, regenerateRecoveryCodes } from '../../../src/lib/server/auth/recovery';
import { relyingPartyFor } from '../../../src/lib/server/auth/relying-party';
import {
	revokeOtherSessions,
	revokeSession,
	validateSessionToken
} from '../../../src/lib/server/auth/sessions';
import { generateToken, hashToken } from '../../../src/lib/server/auth/tokens';
import {
	holdTransaction,
	lockWaiters,
	unreachableDb,
	withCommitted,
	withRollback
} from '../helpers';
import { clock, ORIGIN, request, RP, setUpOwner } from './fixtures';
import { SoftAuthenticator } from './soft-authenticator';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const OWNER_EMAIL = 'owner@example.test';
const CONFIG: EnabledEmailLinkConfig = {
	enabled: true,
	provider: 'test',
	ownerEmail: OWNER_EMAIL,
	from: 'Performance Coach <coach@example.test>'
};

beforeEach(() => testOutbox.clear());

/** The token in the newest recorded message. */
function sentToken(): string {
	const [mail] = testOutbox.list();
	const token = /#t=([A-Za-z0-9_-]+)/.exec(mail?.text ?? '')?.[1];
	if (!token) throw new Error('no link in the outbox');
	return token;
}

async function events(db: Executor, type?: AuthEventType) {
	const rows = await db
		.select()
		.from(authEvents)
		.where(type ? eq(authEvents.type, type) : undefined)
		.orderBy(authEvents.id);
	return rows;
}

/** An owner who completed setup, and deps for the link use-cases on `db` with a clock. */
async function linkOwner(db: Executor, extra: Partial<EmailLinkDeps> = {}) {
	const time = clock();
	const owner = await setUpOwner(db, { now: time.now });
	const deps = { db, now: time.now, config: CONFIG, ...extra } satisfies EmailLinkDeps;
	return { ...owner, time, deps };
}

const session = async (token: string, deps: { db?: Executor; now?: () => Date }) =>
	(await validateSessionToken(token, deps))!.session;

describe('requesting an email sign-in link', () => {
	afterEach(() => {
		setLogLevel('silent');
		vi.restoreAllMocks();
	});

	it('mails one link on the relying party’s origin to the configured address, and stores only its hash', async () => {
		const lines: string[] = [];
		vi.spyOn(console, 'log').mockImplementation((line: unknown) => lines.push(String(line)));
		vi.spyOn(console, 'error').mockImplementation((line: unknown) => lines.push(String(line)));
		setLogLevel('debug');
		await withRollback(async (tx) => {
			const { deps } = await linkOwner(tx);
			await expect(requestSignInLink(request(), deps)).resolves.toBe('sent');

			const mails = testOutbox.list();
			expect(mails).toHaveLength(1);
			expect(mails[0]).toMatchObject({ to: OWNER_EMAIL, from: CONFIG.from });
			const token = sentToken();
			expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
			expect(Buffer.from(token, 'base64url')).toHaveLength(32);
			expect(mails[0]!.text).toContain(`${ORIGIN}/?link#t=${token}\n`);

			const links = await tx.select().from(emailSignInLinks);
			expect(links).toHaveLength(1);
			expect(links[0]!.tokenHash).toBe(hashToken(token));
			expect(links[0]!.expiresAt.getTime() - links[0]!.createdAt.getTime()).toBe(15 * MINUTE);
			const stored = await tx.execute<{ row: string }>(
				sql`select row_to_json(l)::text as row from email_sign_in_links l`
			);
			expect(stored.rows[0]!.row).not.toContain(token);

			const audit = await events(tx);
			expect(audit.map((e) => e.type).filter((t) => t.startsWith('email_link'))).toEqual([
				'email_link.requested',
				'email_link.sent'
			]);
			expect(audit.at(-1)!.detail).toMatchObject({ link: links[0]!.id, provider: 'test' });
			for (const text of [JSON.stringify(audit), ...lines]) {
				expect(text).not.toContain(token);
				expect(text).not.toContain(OWNER_EMAIL);
			}
			expect(lines.some((line) => line.includes('email_link.sent'))).toBe(true);
		});
	});

	it('builds the link from the production origin only, and sends nothing without one', async () => {
		await withRollback(async (tx) => {
			const { deps } = await linkOwner(tx);
			// Production's relying party is fixed, whatever Host the request named...
			const production = relyingPartyFor(
				{ appEnv: 'production' },
				new URL('https://coach.nikocruz.com/')
			);
			expect(production.ok).toBe(true);
			const rp = production as Extract<typeof production, { ok: true }>;
			await requestSignInLink(request({ rp }), deps);
			expect(testOutbox.list()[0]!.text).toContain(
				`https://coach.nikocruz.com/?link#t=${sentToken()}`
			);
			// ...and a forged Host gets none, so the request carries no origin to link to.
			expect(relyingPartyFor({ appEnv: 'production' }, new URL('https://evil.example/')).ok).toBe(
				false
			);
			testOutbox.clear();
			await expect(requestSignInLink(request({ rp: undefined }), deps)).resolves.toBe('refused');
			expect(testOutbox.list()).toEqual([]);
			expect((await events(tx, 'email_link.refused')).at(-1)!.detail).toEqual({
				stage: 'request',
				reason: 'wrong_origin'
			});
		});
	});

	it('refuses the 6th request from one client in 15 minutes, IPv4 or one IPv6 /64, auditing it once a window', async () => {
		await withRollback(async (tx) => {
			const { deps, time } = await linkOwner(tx);
			const { limit, windowMs } = RATE_LIMITS['email.request'];
			expect(limit).toBe(5);
			for (const ips of [
				['203.0.113.5', '203.0.113.5'],
				['2001:db8:1:2::1', '2001:db8:1:2:a:b:c:d']
			]) {
				// An hour apart, so the global hourly cap (10) stays out of the way.
				time.advance(HOUR);
				testOutbox.clear();
				for (let i = 0; i < limit; i++) {
					await expect(requestSignInLink(request({ ip: ips[0]! }), deps)).resolves.toBe('sent');
				}
				await expect(requestSignInLink(request({ ip: ips[1]! }), deps)).resolves.toBe(
					'rate_limited'
				);
				await expect(requestSignInLink(request({ ip: ips[1]! }), deps)).resolves.toBe(
					'rate_limited'
				);
				expect(testOutbox.list()).toHaveLength(limit);
				// The client's window ends after exactly 15 minutes.
				time.advance(windowMs - 1);
				await expect(requestSignInLink(request({ ip: ips[1]! }), deps)).resolves.toBe(
					'rate_limited'
				);
				time.advance(1);
				await expect(requestSignInLink(request({ ip: ips[1]! }), deps)).resolves.toBe('sent');
			}
			// The neighbouring /64 is another client.
			await expect(requestSignInLink(request({ ip: '2001:db8:1:3::1' }), deps)).resolves.toBe(
				'sent'
			);
			const limited = await events(tx, 'rate_limited');
			expect(limited.map((e) => e.detail)).toEqual([
				{ bucket: 'email.request', limit, windowMs },
				{ bucket: 'email.request', limit, windowMs }
			]);

			// The client's next flood, in a new window, is audited once more.
			time.advance(HOUR);
			for (let i = 0; i < limit; i++) {
				await expect(requestSignInLink(request({ ip: '203.0.113.5' }), deps)).resolves.toBe('sent');
			}
			await requestSignInLink(request({ ip: '203.0.113.5' }), deps);
			await requestSignInLink(request({ ip: '203.0.113.5' }), deps);
			expect(await events(tx, 'rate_limited')).toHaveLength(3);
		});
	});

	it('caps requests across all clients at 10 an hour and 20 a day', async () => {
		await withRollback(async (tx) => {
			const { deps, time } = await linkOwner(tx);
			expect(RATE_LIMITS['email.hourly']).toEqual({ limit: 10, windowMs: HOUR });
			expect(RATE_LIMITS['email.daily']).toEqual({ limit: 20, windowMs: 24 * HOUR });
			for (let i = 0; i < 10; i++) {
				await expect(requestSignInLink(request(), deps)).resolves.toBe('sent');
			}
			await expect(requestSignInLink(request(), deps)).resolves.toBe('rate_limited');
			await expect(requestSignInLink(request(), deps)).resolves.toBe('rate_limited');
			expect(testOutbox.list()).toHaveLength(10);

			// A request the hourly cap refused never counts against the day.
			time.advance(HOUR);
			for (let i = 0; i < 10; i++) {
				await expect(requestSignInLink(request(), deps)).resolves.toBe('sent');
			}
			time.advance(HOUR);
			await expect(requestSignInLink(request(), deps)).resolves.toBe('rate_limited');
			await expect(requestSignInLink(request(), deps)).resolves.toBe('rate_limited');
			expect(testOutbox.list()).toHaveLength(20);
			expect((await events(tx, 'rate_limited')).map((e) => e.detail)).toEqual([
				{ bucket: 'email.hourly', limit: 10, windowMs: HOUR },
				{ bucket: 'email.daily', limit: 20, windowMs: 24 * HOUR }
			]);

			time.advance(22 * HOUR);
			await expect(requestSignInLink(request(), deps)).resolves.toBe('sent');
		});
	});

	it('sends nothing without an owner, or once auth:reset-owner reopened setup', async () => {
		await withRollback(async (tx) => {
			const deps: EmailLinkDeps = { db: tx, config: CONFIG };
			await expect(requestSignInLink(request(), deps)).resolves.toBe('refused');
			expect((await events(tx, 'email_link.refused')).map((e) => e.detail)).toEqual([
				{ stage: 'request', reason: 'no_owner' }
			]);

			const owner = await setUpOwner(tx);
			const client = (tx as Executor & { session: { client: PoolClient } }).session.client;
			await resetOwnerAuth(client, { transaction: false });
			await expect(requestSignInLink(request(), deps)).resolves.toBe('refused');
			const refused = (await events(tx, 'email_link.refused')).at(-1)!;
			expect(refused).toMatchObject({
				ownerId: owner.ownerId,
				detail: { stage: 'request', reason: 'setup_open' }
			});
			expect(testOutbox.list()).toEqual([]);
			expect(await tx.select().from(emailSignInLinks)).toEqual([]);
			expect(await events(tx, 'email_link.requested')).toEqual([]);
		});
	});

	it('sends each link with its own id as the Idempotency-Key, so a retried send mails once', async () => {
		await withRollback(async (tx) => {
			const sent: Parameters<Mailer['send']>[0][] = [];
			const recording: Mailer = {
				provider: 'resend',
				send: async (message) => {
					sent.push(message);
					return { id: `msg_${sent.length}` };
				}
			};
			const { deps, time } = await linkOwner(tx, { mailer: recording });
			await requestSignInLink(request(), deps);
			time.advance(MINUTE);
			await requestSignInLink(request(), deps);
			const links = await tx.select().from(emailSignInLinks).orderBy(emailSignInLinks.createdAt);
			expect(links).toHaveLength(2);
			expect(sent.map((m) => m.idempotencyKey)).toEqual(links.map((l) => l.id));
		});
	});

	it('audits a rejecting or hanging mailer as send_failed and never throws', async () => {
		await withRollback(async (tx) => {
			const rejecting: Mailer = {
				provider: 'resend',
				send: () =>
					Promise.reject(new MailError('rejected', { status: 422, providerError: 'invalid_to' }))
			};
			const hanging: Mailer = { provider: 'resend', send: () => new Promise(() => {}) };
			const { deps } = await linkOwner(tx, { mailer: rejecting });
			await expect(requestSignInLink(request(), deps)).resolves.toBe('send_failed');
			await expect(
				requestSignInLink(request(), { ...deps, mailer: hanging, sendTimeoutMs: 50 })
			).resolves.toBe('send_failed');
			const thrower: Mailer = {
				provider: 'resend',
				send: () => {
					throw new Error(`boom ${OWNER_EMAIL}`);
				}
			};
			await expect(requestSignInLink(request(), { ...deps, mailer: thrower })).resolves.toBe(
				'send_failed'
			);

			const links = await tx.select().from(emailSignInLinks).orderBy(emailSignInLinks.createdAt);
			const failed = await events(tx, 'email_link.send_failed');
			expect(failed.map((e) => e.detail)).toEqual([
				{
					link: expect.any(String),
					provider: 'resend',
					code: 'rejected',
					status: 422,
					providerError: 'invalid_to'
				},
				{ link: expect.any(String), provider: 'resend', code: 'timeout' },
				{ link: expect.any(String), provider: 'resend', code: 'unknown' }
			]);
			expect(new Set(failed.map((e) => (e.detail as { link: string }).link))).toEqual(
				new Set(links.map((l) => l.id))
			);
			expect(await events(tx, 'email_link.sent')).toEqual([]);
			expect(JSON.stringify(failed)).not.toContain(OWNER_EMAIL);
		});
	});

	it('resolves even when the database is unreachable', async () => {
		const { db, close } = unreachableDb();
		try {
			await expect(requestSignInLink(request(), { db, config: CONFIG })).resolves.toBe('error');
			expect(testOutbox.list()).toEqual([]);
		} finally {
			await close();
		}
	});

	it('leaves exactly one live link after two concurrent requests', async () => {
		await withCommitted(async (db) => {
			const { deps } = await linkOwner(db);
			const outcomes = await Promise.all([
				requestSignInLink(request(), deps),
				requestSignInLink(request(), deps)
			]);
			expect(outcomes).toEqual(['sent', 'sent']);
			const live = await db
				.select({ tokenHash: emailSignInLinks.tokenHash })
				.from(emailSignInLinks)
				.where(and(isNull(emailSignInLinks.usedAt), isNull(emailSignInLinks.revokedAt)));
			expect(live).toHaveLength(1);
			const sent = testOutbox.list().map((m) => /#t=(\S+)/.exec(m.text)![1]!);
			expect(sent.map((t) => hashToken(t))).toContain(live[0]!.tokenHash);
		});
	});
});

describe('redeeming an email sign-in link', () => {
	it('signs in once with a full email_link session that has no step-up freshness, rotating the presented session', async () => {
		await withRollback(async (tx) => {
			const owner = await linkOwner(tx);
			const { deps, time } = owner;
			await requestSignInLink(request(), deps);
			const token = sentToken();
			time.advance(MINUTE);

			const issued = await completeEmailSignIn(token, owner.token, request(), deps);
			expect(issued.session).toMatchObject({
				ownerId: owner.ownerId,
				kind: 'owner',
				method: 'email_link',
				reauthenticatedAt: null,
				absoluteExpiresAt: new Date(time.now().getTime() + EMAIL_LINK.sessionAbsoluteMs)
			});
			expect(EMAIL_LINK.sessionAbsoluteMs).toBe(SESSION.absoluteMs);
			expect(await validateSessionToken(issued.token, deps)).not.toBeNull();
			expect(await validateSessionToken(owner.token, deps)).toBeNull();
			const repo = createAuthRepository(tx);
			expect(await repo.findSession(owner.session.id)).toMatchObject({ revokedReason: 'rotated' });

			const [link] = await tx.select().from(emailSignInLinks);
			expect(link).toMatchObject({ usedAt: time.now(), sessionId: issued.session.id });
			expect(await events(tx, 'email_link.used')).toMatchObject([
				{ ownerId: owner.ownerId, sessionId: issued.session.id, detail: { link: link!.id } }
			]);

			// The same token again.
			await expect(completeEmailSignIn(token, undefined, request(), deps)).rejects.toMatchObject({
				code: 'link_invalid',
				status: 401
			});
			expect((await events(tx, 'email_link.refused')).at(-1)!.detail).toEqual({
				stage: 'redeem',
				reason: 'used'
			});
		});
	});

	it('replaces a presented recovery session with the same full email_link session', async () => {
		await withRollback(async (tx) => {
			const owner = await linkOwner(tx);
			const { deps } = owner;
			const recovered = await redeemRecoveryCode(
				owner.recoveryCodes[0],
				undefined,
				request(),
				deps
			);
			expect(recovered.session.kind).toBe('recovery');
			await requestSignInLink(request(), deps);

			const issued = await completeEmailSignIn(sentToken(), recovered.token, request(), deps);
			expect(issued.session).toMatchObject({
				kind: 'owner',
				method: 'email_link',
				reauthenticatedAt: null
			});
			expect(await validateSessionToken(recovered.token, deps)).toBeNull();
			expect(await createAuthRepository(tx).findSession(recovered.session.id)).toMatchObject({
				revokedReason: 'rotated'
			});
		});
	});

	it('works until just before 15 minutes, and is expired at exactly 15', async () => {
		await withRollback(async (tx) => {
			const { deps, time } = await linkOwner(tx);
			await requestSignInLink(request(), deps);
			const first = sentToken();
			time.advance(15 * MINUTE - 1);
			await expect(completeEmailSignIn(first, undefined, request(), deps)).resolves.toMatchObject({
				session: { method: 'email_link' }
			});

			await requestSignInLink(request(), deps);
			const second = sentToken();
			time.advance(15 * MINUTE);
			await expect(completeEmailSignIn(second, undefined, request(), deps)).rejects.toMatchObject({
				code: 'link_invalid'
			});
			expect(await events(tx, 'email_link.expired')).toMatchObject([
				{ detail: { stage: 'redeem' } }
			]);
			expect(await events(tx, 'email_link.used')).toHaveLength(1);
		});
	});

	it('refuses a superseded, unknown or malformed token the same way, with the reason in the audit', async () => {
		await withRollback(async (tx) => {
			const { deps } = await linkOwner(tx);
			await requestSignInLink(request(), deps);
			const older = sentToken();
			await requestSignInLink(request(), deps);
			const newer = sentToken();

			const refusals: unknown[] = [];
			for (const token of [older, generateToken(), 'short', `${newer}x`, 42, undefined]) {
				const err = await completeEmailSignIn(token, undefined, request(), deps).catch(
					(e: unknown) => e
				);
				expect(err).toMatchObject({ code: 'link_invalid', status: 401 });
				refusals.push((err as Error).message);
			}
			expect(new Set(refusals).size).toBe(1);
			expect((await events(tx, 'email_link.refused')).map((e) => e.detail)).toEqual([
				{ stage: 'redeem', reason: 'revoked' },
				{ stage: 'redeem', reason: 'unknown' },
				{ stage: 'redeem', reason: 'malformed' },
				{ stage: 'redeem', reason: 'malformed' },
				{ stage: 'redeem', reason: 'malformed' },
				{ stage: 'redeem', reason: 'malformed' }
			]);
			// The newest link still works.
			await expect(completeEmailSignIn(newer, undefined, request(), deps)).resolves.toBeTruthy();
		});
	});

	it('runs no link query for a malformed token', async () => {
		await withRollback(async (tx) => {
			const { deps } = await linkOwner(tx);
			const spy = vi.spyOn(pg.Client.prototype, 'query');
			try {
				await expect(
					completeEmailSignIn('not a token', undefined, request(), deps)
				).rejects.toMatchObject({ code: 'link_invalid' });
				const sent = spy.mock.calls.map((call) => JSON.stringify(call[0]));
				expect(sent.length).toBeGreaterThan(0);
				expect(sent.filter((text) => text.includes('email_sign_in_links'))).toEqual([]);
			} finally {
				spy.mockRestore();
			}
		});
	});

	it('refuses a link once auth:reset-owner reopened setup', async () => {
		await withRollback(async (tx) => {
			const { deps } = await linkOwner(tx);
			await requestSignInLink(request(), deps);
			const token = sentToken();
			const client = (tx as Executor & { session: { client: PoolClient } }).session.client;
			await resetOwnerAuth(client, { transaction: false });
			await expect(completeEmailSignIn(token, undefined, request(), deps)).rejects.toMatchObject({
				code: 'link_invalid'
			});
			expect((await events(tx, 'email_link.refused')).at(-1)!.detail).toEqual({
				stage: 'redeem',
				reason: 'setup_open'
			});
			expect(
				await tx.select().from(authSessions).where(eq(authSessions.method, 'email_link'))
			).toEqual([]);
		});
	});

	it('refuses a pending link after Sign out everywhere else', async () => {
		await withRollback(async (tx) => {
			const owner = await linkOwner(tx);
			const { deps } = owner;
			await requestSignInLink(request(), deps);
			const token = sentToken();
			await revokeOtherSessions(await session(owner.token, deps), request(), deps);
			await expect(completeEmailSignIn(token, undefined, request(), deps)).rejects.toMatchObject({
				code: 'link_invalid'
			});
			expect((await events(tx, 'email_link.refused')).at(-1)!.detail).toEqual({
				stage: 'redeem',
				reason: 'revoked'
			});
		});
	});

	it('lets exactly one of two interleaved redemptions of one token sign in', async () => {
		await withCommitted(async (db) => {
			const { deps } = await linkOwner(db);
			await requestSignInLink(request(), deps);
			const token = sentToken();

			let first: unknown;
			const held = await holdTransaction(async (tx) => {
				first = await completeEmailSignIn(token, undefined, request(), { ...deps, db: tx });
			});
			const second = completeEmailSignIn(token, undefined, request(), deps).catch(
				(e: unknown) => e
			);
			await lockWaiters(1);
			await held.commit();

			expect(first).toMatchObject({ session: { method: 'email_link' } });
			expect(await second).toMatchObject({ code: 'link_invalid' });
			expect(
				await db.select().from(authSessions).where(eq(authSessions.method, 'email_link'))
			).toHaveLength(1);
			expect(await events(db, 'email_link.used')).toHaveLength(1);
			expect((await events(db, 'email_link.refused')).map((e) => e.detail)).toEqual([
				{ stage: 'redeem', reason: 'used' }
			]);
		});
	});

	it('refuses the 11th verification from one client in 15 minutes', async () => {
		await withRollback(async (tx) => {
			const { deps, time } = await linkOwner(tx);
			const client = request({ ip: '203.0.113.11' });
			const { limit } = RATE_LIMITS['email.verify'];
			expect(RATE_LIMITS['email.verify']).toEqual({ limit: 10, windowMs: 15 * MINUTE });
			for (let i = 0; i < limit; i++) {
				await expect(completeEmailSignIn('x', undefined, client, deps)).rejects.toMatchObject({
					code: 'link_invalid'
				});
			}
			await requestSignInLink(request(), deps);
			await expect(completeEmailSignIn(sentToken(), undefined, client, deps)).rejects.toMatchObject(
				{ code: 'rate_limited', status: 429 }
			);
			expect(
				await createEmailLinksRepository(tx).linkStatus(hashToken(sentToken()), time.now())
			).toBe('live');
		});
	});
});

describe('a link session still needs a passkey for step-up actions', () => {
	it('refuses passkey, recovery-code and session changes until a passkey re-authentication', async () => {
		await withRollback(async (tx) => {
			const owner = await linkOwner(tx);
			const { deps } = owner;
			await requestSignInLink(request(), deps);
			const issued = await completeEmailSignIn(sentToken(), undefined, request(), deps);
			const link = await session(issued.token, deps);
			expect(link.reauthenticatedAt).toBeNull();

			const refused = { code: 'reauth_required', status: 403 };
			await expect(beginPasskeyRegistration(link, request(), deps)).rejects.toMatchObject(refused);
			await expect(
				removePasskey(link, owner.authenticator.id, request(), deps)
			).rejects.toMatchObject(refused);
			await expect(regenerateRecoveryCodes(link, request(), deps)).rejects.toMatchObject(refused);
			await expect(revokeSession(link, owner.session.id, request(), deps)).rejects.toMatchObject(
				refused
			);
			await expect(revokeOtherSessions(link, request(), deps)).rejects.toMatchObject(refused);
			await expect(
				renamePasskey(link, owner.authenticator.id, 'Phone', request(), deps)
			).resolves.toBe('Phone');

			const options = await beginReauthentication(link, request(), deps);
			await completeReauthentication(link, owner.authenticator.assert(options), request(), deps);
			const fresh = await session(issued.token, deps);
			const spare = new SoftAuthenticator({ rpId: RP.rpID, origin: ORIGIN });
			await completePasskeyRegistration(
				fresh,
				spare.register(await beginPasskeyRegistration(fresh, request(), deps)),
				request(),
				deps
			);
			await expect(removePasskey(fresh, spare.id, request(), deps)).resolves.toEqual({
				endedSessions: 0
			});
			await expect(regenerateRecoveryCodes(fresh, request(), deps)).resolves.toHaveLength(10);
			await expect(
				revokeSession(fresh, owner.session.id, request(), deps)
			).resolves.toBeUndefined();
			await expect(revokeOtherSessions(fresh, request(), deps)).resolves.toBe(0);
		});
	});
});
