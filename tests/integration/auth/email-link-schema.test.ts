/**
 * Email sign-in links on real Postgres (ADR 0011): the table's CHECKs make Postgres itself hold
 * the 15-minute lifetime and the single-use states, the closed lists accept the new session
 * method and audit events, and the repository keeps one live link per owner and uses each link
 * at most once, also under concurrency.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
	AUTH_EVENT_TYPES,
	authEvents,
	createAuthRepository,
	emailSignInLinks,
	getDb,
	type Executor
} from '../../../src/lib/server/db';
import {
	createEmailLinksRepository,
	EMAIL_LINK_PRUNE_BATCH
} from '../../../src/lib/server/db/repositories/email-links';
import { generateToken, hashToken } from '../../../src/lib/server/auth/tokens';
import { holdTransaction, lockWaiters, withCommitted, withRollback } from '../helpers';

const NOW = new Date('2026-11-05T12:00:00Z');
const MINUTE = 60_000;
const TTL = 15 * MINUTE;
const at = (ms: number) => new Date(NOW.getTime() + ms);
const newHash = () => hashToken(generateToken());

/** An owner who has completed setup (or not, with `setupOpen`). */
async function makeOwner(db: Executor, options: { setupOpen?: boolean } = {}): Promise<string> {
	const repo = createAuthRepository(db);
	const owner = await repo.insertOwner({
		displayName: 'Niko Cruz',
		webauthnUserId: `user-${crypto.randomUUID()}`
	});
	if (!options.setupOpen) await repo.markSetupCompleted(owner.id, at(-60 * MINUTE));
	return owner.id;
}

async function makeSession(db: Executor, ownerId: string): Promise<string> {
	const session = await createAuthRepository(db).insertSession({
		ownerId,
		tokenHash: newHash(),
		method: 'email_link',
		expiresAt: at(30 * 86_400_000),
		absoluteExpiresAt: at(90 * 86_400_000)
	});
	return session.id;
}

type LinkValues = typeof emailSignInLinks.$inferInsert;

function insertLink(db: Executor, ownerId: string, values: Partial<LinkValues> = {}) {
	return db
		.insert(emailSignInLinks)
		.values({ ownerId, tokenHash: newHash(), createdAt: NOW, expiresAt: at(TTL), ...values })
		.returning()
		.then((rows) => rows[0]!);
}

type PgError = { code?: string; constraint?: string };
const UNDO = Symbol('undo');

/** Run `write` in an always-undone savepoint: the Postgres error it failed with, or null. */
async function attempt(db: Executor, write: (tx: Executor) => Promise<unknown>) {
	try {
		await db.transaction(async (tx) => {
			await write(tx);
			throw UNDO;
		});
	} catch (err) {
		if (err === UNDO) return null;
		const { code, constraint } = ((err as { cause?: PgError }).cause ?? err) as PgError;
		return { code, constraint };
	}
	throw new Error('unreachable');
}

const check = (constraint: string) => ({ code: '23514', constraint });

async function liveLinks(db: Executor, ownerId: string) {
	return db
		.select({ tokenHash: emailSignInLinks.tokenHash })
		.from(emailSignInLinks)
		.where(
			and(
				eq(emailSignInLinks.ownerId, ownerId),
				isNull(emailSignInLinks.usedAt),
				isNull(emailSignInLinks.revokedAt)
			)
		);
}

describe('the email_sign_in_links table', () => {
	it('stores only a 64-hex SHA-256 per link, each one once', async () => {
		await withRollback(async (tx) => {
			const owner = await makeOwner(tx);
			const hash = newHash();
			expect(await attempt(tx, (db) => insertLink(db, owner, { tokenHash: hash }))).toBeNull();
			await insertLink(tx, owner, { tokenHash: hash });
			expect(await attempt(tx, (db) => insertLink(db, owner, { tokenHash: hash }))).toEqual({
				code: '23505',
				constraint: 'email_sign_in_links_token_hash_uq'
			});
			for (const bad of [generateToken(), hash.toUpperCase(), hash.slice(1), `${hash}0`]) {
				expect(await attempt(tx, (db) => insertLink(db, owner, { tokenHash: bad })), bad).toEqual(
					check('email_sign_in_links_token_hash_ck')
				);
			}
		});
	});

	it('refuses a lifetime over 15 minutes, or none at all', async () => {
		await withRollback(async (tx) => {
			const owner = await makeOwner(tx);
			const lifetime = (ms: number) =>
				attempt(tx, (db) => insertLink(db, owner, { expiresAt: at(ms) }));
			expect(await lifetime(TTL)).toBeNull();
			expect(await lifetime(1)).toBeNull();
			expect(await lifetime(TTL + 1_000)).toEqual(check('email_sign_in_links_lifetime_ck'));
			expect(await lifetime(0)).toEqual(check('email_sign_in_links_lifetime_ck'));
			expect(await lifetime(-MINUTE)).toEqual(check('email_sign_in_links_lifetime_ck'));
		});
	});

	it('is never both used and revoked, and names a session only once used', async () => {
		await withRollback(async (tx) => {
			const owner = await makeOwner(tx);
			const sessionId = await makeSession(tx, owner);
			const link = (values: Partial<LinkValues>) =>
				attempt(tx, (db) => insertLink(db, owner, values));
			expect(await link({ usedAt: at(MINUTE) })).toBeNull();
			expect(await link({ revokedAt: at(MINUTE) })).toBeNull();
			expect(await link({ usedAt: at(MINUTE), revokedAt: at(MINUTE) })).toEqual(
				check('email_sign_in_links_state_ck')
			);
			expect(await link({ sessionId })).toEqual(check('email_sign_in_links_session_ck'));
			expect(await link({ sessionId, revokedAt: at(MINUTE) })).toEqual(
				check('email_sign_in_links_session_ck')
			);
			expect(await link({ sessionId, usedAt: at(MINUTE) })).toBeNull();
		});
	});

	it('keeps a used link when its session is deleted, and goes with its owner', async () => {
		await withRollback(async (tx) => {
			const owner = await makeOwner(tx);
			const sessionId = await makeSession(tx, owner);
			const link = await insertLink(tx, owner, { usedAt: at(MINUTE), sessionId });
			await tx.execute(sql`delete from auth_sessions where id = ${sessionId}`);
			const [kept] = await tx
				.select()
				.from(emailSignInLinks)
				.where(eq(emailSignInLinks.id, link.id));
			expect(kept).toMatchObject({ id: link.id, sessionId: null });
			await tx.execute(sql`delete from owners where id = ${owner}`);
			expect(await tx.select().from(emailSignInLinks)).toEqual([]);
		});
	});

	it('accepts the email_link session method and every email_link audit event, still nothing else', async () => {
		await withRollback(async (tx) => {
			const owner = await makeOwner(tx);
			expect(await attempt(tx, (db) => makeSession(db, owner))).toBeNull();
			const session = (method: string) =>
				attempt(tx, (db) =>
					db.execute(
						sql`insert into auth_sessions (owner_id, token_hash, method, expires_at, absolute_expires_at)
							values (${owner}, ${newHash()}, ${method}, ${at(TTL)}, ${at(TTL)})`
					)
				);
			expect(await session('email_link')).toBeNull();
			expect(await session('magic_link')).toEqual(check('auth_sessions_method_ck'));

			const added = AUTH_EVENT_TYPES.filter((type) => type.startsWith('email_link.'));
			expect(added).toEqual([
				'email_link.requested',
				'email_link.sent',
				'email_link.send_failed',
				'email_link.used',
				'email_link.expired',
				'email_link.refused'
			]);
			for (const type of added) {
				expect(await attempt(tx, (db) => db.insert(authEvents).values({ type })), type).toBeNull();
			}
			const event = (type: string) =>
				attempt(tx, (db) => db.execute(sql`insert into auth_events (type) values (${type})`));
			expect(await event('email_link.opened')).toEqual(check('auth_events_type_ck'));
			expect(await event('signin.succeeded')).toBeNull();
		});
	});

	it('is cleared by withCommitted’s truncate', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			await createEmailLinksRepository(db).issueLink(owner, newHash(), NOW, TTL);
		});
		const { rows } = await getDb().execute<{ n: number }>(
			sql`select count(*)::int as n from email_sign_in_links`
		);
		expect(rows[0]!.n).toBe(0);
	});
});

describe('the email links repository', () => {
	it('uses a link once, and never a used, revoked, expired or unknown one', async () => {
		await withRollback(async (tx) => {
			const owner = await makeOwner(tx);
			const repo = createEmailLinksRepository(tx);
			const hash = newHash();
			const link = await repo.issueLink(owner, hash, NOW, TTL);
			expect(link).toMatchObject({
				ownerId: owner,
				tokenHash: hash,
				createdAt: NOW,
				expiresAt: at(TTL)
			});

			expect(await repo.consumeLink(hash, at(MINUTE))).toEqual({ id: link.id, ownerId: owner });
			expect(await repo.consumeLink(hash, at(MINUTE))).toBeNull();
			const [used] = await tx
				.select()
				.from(emailSignInLinks)
				.where(eq(emailSignInLinks.id, link.id));
			expect(used!.usedAt).toEqual(at(MINUTE));

			const revoked = newHash();
			await insertLink(tx, owner, { tokenHash: revoked, revokedAt: NOW });
			expect(await repo.consumeLink(revoked, at(MINUTE))).toBeNull();

			const expiring = newHash();
			await insertLink(tx, owner, { tokenHash: expiring });
			expect(await repo.consumeLink(expiring, at(TTL))).toBeNull(); // exactly at expires_at
			expect(await repo.consumeLink(expiring, at(TTL + 1))).toBeNull();
			expect(await repo.consumeLink(expiring, at(TTL - 1))).not.toBeNull();

			expect(await repo.consumeLink(newHash(), at(MINUTE))).toBeNull();
		});
	});

	it('uses no link while first-run setup is open', async () => {
		await withRollback(async (tx) => {
			const owner = await makeOwner(tx, { setupOpen: true });
			const repo = createEmailLinksRepository(tx);
			const hash = newHash();
			await repo.issueLink(owner, hash, NOW, TTL);
			expect(await repo.consumeLink(hash, at(MINUTE))).toBeNull();
			expect(await repo.linkStatus(hash, at(MINUTE))).toBe('live');
		});
	});

	it('lets concurrent uses of one link succeed once', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			const hash = newHash();
			const link = await createEmailLinksRepository(db).issueLink(owner, hash, NOW, TTL);
			let first: unknown;
			const held = await holdTransaction(async (tx) => {
				first = await createEmailLinksRepository(tx).consumeLink(hash, at(MINUTE));
			});
			const second = createEmailLinksRepository(db).consumeLink(hash, at(MINUTE));
			await lockWaiters(1);
			await held.commit();
			expect(first).toEqual({ id: link.id, ownerId: owner });
			expect(await second).toBeNull();
		});
	});

	it('keeps only the newest link live', async () => {
		await withRollback(async (tx) => {
			const owner = await makeOwner(tx);
			const repo = createEmailLinksRepository(tx);
			const older = newHash();
			const newer = newHash();
			await repo.issueLink(owner, older, NOW, TTL);
			await repo.issueLink(owner, newer, at(MINUTE), TTL);
			expect(await repo.linkStatus(older, at(2 * MINUTE))).toBe('revoked');
			expect(await repo.consumeLink(older, at(2 * MINUTE))).toBeNull();
			expect(await liveLinks(tx, owner)).toEqual([{ tokenHash: newer }]);
			expect(await repo.consumeLink(newer, at(2 * MINUTE))).not.toBeNull();
		});
	});

	it('leaves exactly one live link after two concurrent issues', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			const first = newHash();
			const second = newHash();
			// The first issue holds the owner row lock with its link written but not committed:
			// without the lock the second could not see that link to revoke it.
			const held = await holdTransaction((tx) =>
				createEmailLinksRepository(tx).issueLink(owner, first, NOW, TTL)
			);
			const issuing = createEmailLinksRepository(db).issueLink(owner, second, NOW, TTL);
			await lockWaiters(1);
			await held.commit();
			await issuing;
			expect(await liveLinks(db, owner)).toEqual([{ tokenHash: second }]);
			expect(await createEmailLinksRepository(db).linkStatus(first, NOW)).toBe('revoked');
		});
	});

	it('lets sign-ins write for the owner while an issue holds its lock', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			const held = await holdTransaction((tx) =>
				createEmailLinksRepository(tx).issueLink(owner, newHash(), NOW, TTL)
			);
			// A session insert's foreign-key check takes FOR KEY SHARE on the owner row, which
			// only FOR UPDATE blocks: it must not wait for the issue's transaction.
			const inserting = db.transaction(async (tx) => {
				await tx.execute(sql`set local lock_timeout = '1s'`);
				return makeSession(tx, owner);
			});
			await expect(inserting).resolves.toEqual(expect.any(String));
			await held.commit();
		});
	});

	it('reports each state of a link', async () => {
		await withRollback(async (tx) => {
			const owner = await makeOwner(tx);
			const repo = createEmailLinksRepository(tx);
			const hashes = { live: newHash(), used: newHash(), revoked: newHash() };
			await insertLink(tx, owner, { tokenHash: hashes.live });
			await insertLink(tx, owner, { tokenHash: hashes.used, usedAt: NOW });
			await insertLink(tx, owner, { tokenHash: hashes.revoked, revokedAt: NOW });
			expect(await repo.linkStatus(hashes.live, at(TTL - 1))).toBe('live');
			expect(await repo.linkStatus(hashes.live, at(TTL))).toBe('expired');
			expect(await repo.linkStatus(hashes.used, at(TTL * 2))).toBe('used');
			expect(await repo.linkStatus(hashes.revoked, at(TTL * 2))).toBe('revoked');
			expect(await repo.linkStatus(newHash(), NOW)).toBe('unknown');
		});
	});

	it('prunes links a day after they expired, a batch per issue', async () => {
		await withRollback(async (tx) => {
			const owner = await makeOwner(tx);
			const expiredAgo = (ms: number, count = 1) =>
				tx
					.insert(emailSignInLinks)
					.values(
						Array.from({ length: count }, () => ({
							ownerId: owner,
							tokenHash: newHash(),
							createdAt: at(-ms - TTL),
							expiresAt: at(-ms)
						}))
					)
					.returning({ tokenHash: emailSignInLinks.tokenHash });
			const day = 86_400_000;
			const recent = await expiredAgo(day - MINUTE);
			await expiredAgo(day + MINUTE, EMAIL_LINK_PRUNE_BATCH + 1);

			const repo = createEmailLinksRepository(tx);
			await repo.issueLink(owner, newHash(), NOW, TTL);
			const count = async () =>
				(await tx.execute<{ n: number }>(sql`select count(*)::int as n from email_sign_in_links`))
					.rows[0]!.n;
			// The recent one, the new one, and the one stale link past the batch.
			expect(await count()).toBe(3);
			expect(await repo.linkStatus(recent[0]!.tokenHash, NOW)).toBe('expired');
			await repo.issueLink(owner, newHash(), at(MINUTE), TTL);
			expect(await count()).toBe(3); // the last stale one went, the previous link was revoked
		});
	});

	it('revokes only live links, and attaches a session only to a used one', async () => {
		await withRollback(async (tx) => {
			const owner = await makeOwner(tx);
			const repo = createEmailLinksRepository(tx);
			const live = await insertLink(tx, owner);
			const expired = await insertLink(tx, owner, { createdAt: at(-TTL), expiresAt: NOW });
			const used = await insertLink(tx, owner, { usedAt: at(1) });
			const revoked = await insertLink(tx, owner, { revokedAt: at(1) });

			expect(await repo.revokeLiveLinks(owner, at(MINUTE))).toBe(1);
			const rows = new Map(
				(await tx.select().from(emailSignInLinks)).map((row) => [row.id, row] as const)
			);
			expect(rows.get(live.id)).toMatchObject({ revokedAt: at(MINUTE), usedAt: null });
			expect(rows.get(expired.id)).toMatchObject({ revokedAt: null, usedAt: null });
			expect(rows.get(used.id)).toMatchObject({ revokedAt: null, usedAt: at(1) });
			expect(rows.get(revoked.id)).toMatchObject({ revokedAt: at(1) });

			const sessionId = await makeSession(tx, owner);
			expect(await repo.attachSession(live.id, sessionId)).toBe(false);
			expect(await repo.attachSession(used.id, sessionId)).toBe(true);
			const [attached] = await tx
				.select()
				.from(emailSignInLinks)
				.where(eq(emailSignInLinks.id, used.id));
			expect(attached!.sessionId).toBe(sessionId);
		});
	});
});
