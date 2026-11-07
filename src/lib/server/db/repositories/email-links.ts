/**
 * Email sign-in links (schema/auth.ts `email_sign_in_links`, ADR 0011): issue, redeem, inspect
 * and revoke. Plain data access; the email-link use-case owns the policy, the mail and the audit.
 * Imported by path (not through the db barrel). Every time-dependent query takes the time as a
 * parameter, so expiry is testable without waiting.
 *
 * A link is live while it is unused, unrevoked and unexpired. The table's CHECKs cap its lifetime
 * and keep used and revoked apart; this module keeps only the newest link live and uses each one
 * at most once.
 */
import { and, eq, gt, inArray, isNotNull, isNull, lt } from 'drizzle-orm';
import { emailSignInLinks, owners } from '../schema';
import type { Executor } from '../types';

export type EmailLinkRow = typeof emailSignInLinks.$inferSelect;

/** What a token hash names, for the audit only: a refused link is refused the same way. */
export type EmailLinkStatus = 'unknown' | 'used' | 'revoked' | 'expired' | 'live';

/** Links are deleted once they expired longer ago than this (when a new link is issued). */
export const EMAIL_LINK_PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;
/** At most this many expired links are deleted per issued link, so issuing stays cheap. */
export const EMAIL_LINK_PRUNE_BATCH = 100;

const live = (now: Date) =>
	and(
		isNull(emailSignInLinks.usedAt),
		isNull(emailSignInLinks.revokedAt),
		gt(emailSignInLinks.expiresAt, now)
	);

export function createEmailLinksRepository(db: Executor) {
	/** Revoke the owner's live links. Used, revoked and expired links keep their state. */
	async function revokeLiveLinks(ownerId: string, now: Date, tx: Executor = db): Promise<number> {
		const revoked = await tx
			.update(emailSignInLinks)
			.set({ revokedAt: now })
			.where(and(eq(emailSignInLinks.ownerId, ownerId), live(now)))
			.returning({ id: emailSignInLinks.id });
		return revoked.length;
	}

	return {
		/**
		 * Store a new link valid for `ttlMs` and make it the owner's only live one. Runs in the
		 * caller's transaction (as a savepoint; in its own transaction on a bare pool): the owner
		 * row lock serialises concurrent issues, so they always leave exactly one live link. Up to
		 * EMAIL_LINK_PRUNE_BATCH links that expired over EMAIL_LINK_PRUNE_AFTER_MS ago are deleted.
		 */
		async issueLink(
			ownerId: string,
			tokenHash: string,
			now: Date,
			ttlMs: number
		): Promise<EmailLinkRow> {
			return db.transaction(async (tx) => {
				const [owner] = await tx
					.select({ id: owners.id })
					.from(owners)
					.where(eq(owners.id, ownerId))
					.for('no key update');
				if (!owner) throw new Error('issue email link: no such owner');
				await revokeLiveLinks(ownerId, now, tx);
				const stale = tx
					.select({ id: emailSignInLinks.id })
					.from(emailSignInLinks)
					.where(
						lt(emailSignInLinks.expiresAt, new Date(now.getTime() - EMAIL_LINK_PRUNE_AFTER_MS))
					)
					.limit(EMAIL_LINK_PRUNE_BATCH)
					.for('update', { skipLocked: true });
				await tx.delete(emailSignInLinks).where(inArray(emailSignInLinks.id, stale));
				const [row] = await tx
					.insert(emailSignInLinks)
					.values({
						ownerId,
						tokenHash,
						createdAt: now,
						expiresAt: new Date(now.getTime() + ttlMs)
					})
					.returning();
				if (!row) throw new Error('issue email link returned no row');
				return row;
			});
		},

		/**
		 * Redeem a link: one conditional UPDATE, so of any number of concurrent uses exactly one
		 * matches (the others wait for its row lock, then find it used). Null unless the link is
		 * live at `now` and the owner has completed setup.
		 */
		async consumeLink(
			tokenHash: string,
			now: Date
		): Promise<{ id: string; ownerId: string } | null> {
			const [row] = await db
				.update(emailSignInLinks)
				.set({ usedAt: now })
				.from(owners)
				.where(
					and(
						eq(emailSignInLinks.tokenHash, tokenHash),
						live(now),
						eq(owners.id, emailSignInLinks.ownerId),
						isNotNull(owners.setupCompletedAt)
					)
				)
				.returning({ id: emailSignInLinks.id, ownerId: emailSignInLinks.ownerId });
			return row ?? null;
		},

		/** Which state the link of this hash is in at `now`; for the audit only. */
		async linkStatus(tokenHash: string, now: Date): Promise<EmailLinkStatus> {
			const [row] = await db
				.select({
					usedAt: emailSignInLinks.usedAt,
					revokedAt: emailSignInLinks.revokedAt,
					expiresAt: emailSignInLinks.expiresAt
				})
				.from(emailSignInLinks)
				.where(eq(emailSignInLinks.tokenHash, tokenHash))
				.limit(1);
			if (!row) return 'unknown';
			if (row.usedAt) return 'used';
			if (row.revokedAt) return 'revoked';
			return row.expiresAt > now ? 'live' : 'expired';
		},

		/** Record the session a used link created. False if the link is not used. */
		async attachSession(id: string, sessionId: string): Promise<boolean> {
			const updated = await db
				.update(emailSignInLinks)
				.set({ sessionId })
				.where(and(eq(emailSignInLinks.id, id), isNotNull(emailSignInLinks.usedAt)))
				.returning({ id: emailSignInLinks.id });
			return updated.length === 1;
		},

		revokeLiveLinks: (ownerId: string, now: Date) => revokeLiveLinks(ownerId, now)
	};
}

export type EmailLinksRepository = ReturnType<typeof createEmailLinksRepository>;
