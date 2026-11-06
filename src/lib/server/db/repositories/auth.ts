/**
 * Auth persistence: owner, used setup tokens, passkeys, sessions, recovery codes, challenges,
 * audit log and rate limits. Every time-dependent query takes the time as a parameter (services
 * pass their clock), so expiry and windows are testable without waiting.
 */
import { and, asc, count, desc, eq, gt, isNull, lt, ne, sql } from 'drizzle-orm';
import {
	authEvents,
	authRateLimits,
	authSessions,
	owners,
	passkeyCredentials,
	recoveryCodes,
	usedSetupTokens,
	webauthnChallenges,
	type ChallengePurpose
} from '../schema';
import type { Executor } from '../types';

export type OwnerRow = typeof owners.$inferSelect;
export type PasskeyRow = typeof passkeyCredentials.$inferSelect;
export type NewPasskey = typeof passkeyCredentials.$inferInsert;
export type SessionRow = typeof authSessions.$inferSelect;
export type NewSession = typeof authSessions.$inferInsert;
export type ChallengeRow = typeof webauthnChallenges.$inferSelect;
export type NewChallenge = typeof webauthnChallenges.$inferInsert;
export type AuthEventRow = typeof authEvents.$inferSelect;
export type NewAuthEvent = typeof authEvents.$inferInsert;

export interface ActiveSession {
	session: SessionRow;
	owner: Pick<OwnerRow, 'id' | 'displayName' | 'webauthnUserId'>;
}

function first<T>(rows: T[], what: string): T {
	const [row] = rows;
	if (!row) throw new Error(`${what} returned no row`);
	return row;
}

export function createAuthRepository(db: Executor) {
	return {
		// ---- owner -----------------------------------------------------------------------
		async getOwner(): Promise<OwnerRow | null> {
			const [row] = await db.select().from(owners).limit(1);
			return row ?? null;
		},

		/** Serialises first-run setup (and owner resets) within the current transaction. */
		async lockOwnerSetup(): Promise<void> {
			await db.execute(sql`select pg_advisory_xact_lock(727002)`);
		},

		async insertOwner(values: { displayName: string; webauthnUserId: string }) {
			return first(await db.insert(owners).values(values).returning(), 'insert owner');
		},

		/** Re-attach an existing owner to a new first passkey (after an owner reset). */
		async updateOwnerIdentity(
			ownerId: string,
			values: { displayName: string; webauthnUserId: string }
		): Promise<OwnerRow> {
			return first(
				await db.update(owners).set(values).where(eq(owners.id, ownerId)).returning(),
				'update owner'
			);
		},

		async markSetupCompleted(ownerId: string, at: Date): Promise<void> {
			await db.update(owners).set({ setupCompletedAt: at }).where(eq(owners.id, ownerId));
		},

		/** Has a setup already been completed with the token of this hash? */
		async setupTokenUsed(tokenHash: string): Promise<boolean> {
			const [row] = await db
				.select({ tokenHash: usedSetupTokens.tokenHash })
				.from(usedSetupTokens)
				.where(eq(usedSetupTokens.tokenHash, tokenHash))
				.limit(1);
			return row !== undefined;
		},

		/** Record a setup token as used. False if it already was: a token completes one setup. */
		async claimSetupToken(tokenHash: string, at: Date): Promise<boolean> {
			const inserted = await db
				.insert(usedSetupTokens)
				.values({ tokenHash, usedAt: at })
				.onConflictDoNothing()
				.returning({ tokenHash: usedSetupTokens.tokenHash });
			return inserted.length === 1;
		},

		// ---- passkeys ----------------------------------------------------------------------
		async listPasskeys(ownerId: string): Promise<PasskeyRow[]> {
			return db
				.select()
				.from(passkeyCredentials)
				.where(eq(passkeyCredentials.ownerId, ownerId))
				.orderBy(asc(passkeyCredentials.createdAt));
		},

		async countPasskeys(ownerId?: string): Promise<number> {
			const [row] = await db
				.select({ n: count() })
				.from(passkeyCredentials)
				.where(ownerId ? eq(passkeyCredentials.ownerId, ownerId) : undefined);
			return Number(row?.n ?? 0);
		},

		async findPasskey(id: string): Promise<PasskeyRow | null> {
			const [row] = await db
				.select()
				.from(passkeyCredentials)
				.where(eq(passkeyCredentials.id, id))
				.limit(1);
			return row ?? null;
		},

		async insertPasskey(values: NewPasskey): Promise<PasskeyRow> {
			return first(
				await db.insert(passkeyCredentials).values(values).returning(),
				'insert passkey'
			);
		},

		/**
		 * Record a successful assertion. The counter only moves forward: a concurrent request
		 * that verified an older counter cannot roll it back.
		 */
		async recordPasskeyUse(
			id: string,
			values: { counter: number; backedUp: boolean; deviceType: PasskeyRow['deviceType'] },
			at: Date
		): Promise<boolean> {
			const updated = await db
				.update(passkeyCredentials)
				.set({ ...values, lastUsedAt: at })
				.where(
					and(
						eq(passkeyCredentials.id, id),
						sql`(${passkeyCredentials.counter} < ${values.counter} or ${values.counter} = 0)`
					)
				)
				.returning({ id: passkeyCredentials.id });
			return updated.length === 1;
		},

		async renamePasskey(ownerId: string, id: string, nickname: string): Promise<boolean> {
			const updated = await db
				.update(passkeyCredentials)
				.set({ nickname })
				.where(and(eq(passkeyCredentials.id, id), eq(passkeyCredentials.ownerId, ownerId)))
				.returning({ id: passkeyCredentials.id });
			return updated.length === 1;
		},

		async deletePasskey(ownerId: string, id: string): Promise<boolean> {
			const deleted = await db
				.delete(passkeyCredentials)
				.where(and(eq(passkeyCredentials.id, id), eq(passkeyCredentials.ownerId, ownerId)))
				.returning({ id: passkeyCredentials.id });
			return deleted.length === 1;
		},

		/** Row-lock the owner's passkeys so "never remove the last one" holds under concurrency. */
		async lockPasskeys(ownerId: string): Promise<number> {
			const rows = await db
				.select({ id: passkeyCredentials.id })
				.from(passkeyCredentials)
				.where(eq(passkeyCredentials.ownerId, ownerId))
				.for('update');
			return rows.length;
		},

		// ---- sessions ----------------------------------------------------------------------
		async insertSession(values: NewSession): Promise<SessionRow> {
			return first(await db.insert(authSessions).values(values).returning(), 'insert session');
		},

		/** The live session for a token hash: not revoked, not expired (sliding or absolute). */
		async findActiveSession(tokenHash: string, now: Date): Promise<ActiveSession | null> {
			const [row] = await db
				.select({
					session: authSessions,
					owner: {
						id: owners.id,
						displayName: owners.displayName,
						webauthnUserId: owners.webauthnUserId
					}
				})
				.from(authSessions)
				.innerJoin(owners, eq(owners.id, authSessions.ownerId))
				.where(
					and(
						eq(authSessions.tokenHash, tokenHash),
						isNull(authSessions.revokedAt),
						gt(authSessions.expiresAt, now),
						gt(authSessions.absoluteExpiresAt, now)
					)
				)
				.limit(1);
			return row ?? null;
		},

		async findSession(id: string): Promise<SessionRow | null> {
			const [row] = await db.select().from(authSessions).where(eq(authSessions.id, id)).limit(1);
			return row ?? null;
		},

		/**
		 * Row-lock a session if it is still live (not revoked, not expired), so nothing can revoke
		 * it before the transaction ends. False if it has ended.
		 */
		async lockLiveSession(id: string, now: Date): Promise<boolean> {
			const rows = await db
				.select({ id: authSessions.id })
				.from(authSessions)
				.where(
					and(
						eq(authSessions.id, id),
						isNull(authSessions.revokedAt),
						gt(authSessions.expiresAt, now),
						gt(authSessions.absoluteExpiresAt, now)
					)
				)
				.for('update');
			return rows.length === 1;
		},

		async touchSession(id: string, values: { lastSeenAt: Date; expiresAt?: Date }) {
			await db.update(authSessions).set(values).where(eq(authSessions.id, id));
		},

		async listActiveSessions(ownerId: string, now: Date): Promise<SessionRow[]> {
			return db
				.select()
				.from(authSessions)
				.where(
					and(
						eq(authSessions.ownerId, ownerId),
						isNull(authSessions.revokedAt),
						gt(authSessions.expiresAt, now),
						gt(authSessions.absoluteExpiresAt, now)
					)
				)
				.orderBy(desc(authSessions.lastSeenAt));
		},

		async revokeSession(id: string, reason: string, at: Date, ownerId?: string): Promise<boolean> {
			const updated = await db
				.update(authSessions)
				.set({ revokedAt: at, revokedReason: reason })
				.where(
					and(
						eq(authSessions.id, id),
						isNull(authSessions.revokedAt),
						ownerId ? eq(authSessions.ownerId, ownerId) : undefined
					)
				)
				.returning({ id: authSessions.id });
			return updated.length === 1;
		},

		/**
		 * Row-lock every unrevoked session of the owner except `exceptId` (in id order, so two
		 * callers cannot deadlock), waiting for any transaction that holds one of them.
		 */
		async lockOtherSessions(ownerId: string, exceptId: string | null): Promise<void> {
			await db
				.select({ id: authSessions.id })
				.from(authSessions)
				.where(
					and(
						eq(authSessions.ownerId, ownerId),
						isNull(authSessions.revokedAt),
						exceptId ? ne(authSessions.id, exceptId) : undefined
					)
				)
				.orderBy(asc(authSessions.id))
				.for('update');
		},

		/** Revoke every live session of the owner except `exceptId`. Returns how many. */
		async revokeOtherSessions(
			ownerId: string,
			exceptId: string | null,
			reason: string,
			at: Date
		): Promise<number> {
			const updated = await db
				.update(authSessions)
				.set({ revokedAt: at, revokedReason: reason })
				.where(
					and(
						eq(authSessions.ownerId, ownerId),
						isNull(authSessions.revokedAt),
						exceptId ? ne(authSessions.id, exceptId) : undefined
					)
				)
				.returning({ id: authSessions.id });
			return updated.length;
		},

		async revokeSessionsUsingPasskey(
			credentialId: string,
			exceptId: string | null,
			reason: string,
			at: Date
		): Promise<number> {
			const updated = await db
				.update(authSessions)
				.set({ revokedAt: at, revokedReason: reason })
				.where(
					and(
						eq(authSessions.credentialId, credentialId),
						isNull(authSessions.revokedAt),
						exceptId ? ne(authSessions.id, exceptId) : undefined
					)
				)
				.returning({ id: authSessions.id });
			return updated.length;
		},

		// ---- recovery codes ----------------------------------------------------------------
		/** Replace the owner's codes (all of them, used or not) with a new set of hashes. */
		async replaceRecoveryCodes(ownerId: string, hashes: string[], at: Date): Promise<void> {
			await db.delete(recoveryCodes).where(eq(recoveryCodes.ownerId, ownerId));
			if (hashes.length) {
				await db
					.insert(recoveryCodes)
					.values(hashes.map((codeHash) => ({ ownerId, codeHash, createdAt: at })));
			}
		},

		/** Atomically burn an unused code. Returns its owner, or null if unknown or already used. */
		async burnRecoveryCode(codeHash: string, at: Date): Promise<string | null> {
			const [row] = await db
				.update(recoveryCodes)
				.set({ usedAt: at })
				.where(and(eq(recoveryCodes.codeHash, codeHash), isNull(recoveryCodes.usedAt)))
				.returning({ ownerId: recoveryCodes.ownerId });
			return row?.ownerId ?? null;
		},

		async recoveryCodeStatus(ownerId: string): Promise<{ total: number; unused: number }> {
			const [row] = await db
				.select({
					total: count(),
					unused: sql<number>`count(*) filter (where ${recoveryCodes.usedAt} is null)`
				})
				.from(recoveryCodes)
				.where(eq(recoveryCodes.ownerId, ownerId));
			return { total: Number(row?.total ?? 0), unused: Number(row?.unused ?? 0) };
		},

		// ---- challenges --------------------------------------------------------------------
		async insertChallenge(values: NewChallenge, now: Date): Promise<ChallengeRow> {
			// Opportunistic cleanup keeps the table tiny without a scheduler.
			await db.delete(webauthnChallenges).where(lt(webauthnChallenges.expiresAt, now));
			return first(
				await db.insert(webauthnChallenges).values(values).returning(),
				'insert challenge'
			);
		},

		/**
		 * Single use: delete the challenge for this purpose and return it. Expired challenges are
		 * deleted too but not returned.
		 */
		async consumeChallenge(
			challenge: string,
			purpose: ChallengePurpose,
			now: Date
		): Promise<ChallengeRow | null> {
			const [row] = await db
				.delete(webauthnChallenges)
				.where(
					and(eq(webauthnChallenges.challenge, challenge), eq(webauthnChallenges.purpose, purpose))
				)
				.returning();
			return row && row.expiresAt > now ? row : null;
		},

		// ---- audit log ---------------------------------------------------------------------
		async insertEvent(values: NewAuthEvent): Promise<void> {
			await db.insert(authEvents).values(values);
		},

		async recentEvents(limit = 20): Promise<AuthEventRow[]> {
			// `id` breaks ties: events written in one transaction share its now().
			return db
				.select()
				.from(authEvents)
				.orderBy(desc(authEvents.occurredAt), desc(authEvents.id))
				.limit(limit);
		},

		// ---- rate limits -------------------------------------------------------------------
		/**
		 * Count one hit in a fixed window and return the count so far (this hit included), in a
		 * single atomic upsert: concurrent requests on any server instance share the counter.
		 */
		async hitRateLimit(key: string, windowMs: number, now: Date): Promise<number> {
			const windowStartsAfter = new Date(now.getTime() - windowMs);
			const [row] = await db
				.insert(authRateLimits)
				.values({ key, windowStart: now, count: 1 })
				.onConflictDoUpdate({
					target: authRateLimits.key,
					set: {
						count: sql`case when ${authRateLimits.windowStart} <= ${windowStartsAfter} then 1 else ${authRateLimits.count} + 1 end`,
						windowStart: sql`case when ${authRateLimits.windowStart} <= ${windowStartsAfter} then ${now} else ${authRateLimits.windowStart} end`
					}
				})
				.returning({ count: authRateLimits.count });
			return row?.count ?? 1;
		},

		async pruneRateLimits(olderThan: Date): Promise<void> {
			await db.delete(authRateLimits).where(lt(authRateLimits.windowStart, olderThan));
		}
	};
}

export type AuthRepository = ReturnType<typeof createAuthRepository>;
