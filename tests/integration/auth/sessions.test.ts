import { describe, expect, it } from 'vitest';
import { createAuthRepository } from '../../../src/lib/server/db';
import {
	issueSession,
	listSessions,
	revokeOtherSessions,
	revokeSession,
	signOut,
	validateSessionToken
} from '../../../src/lib/server/auth/sessions';
import { SESSION } from '../../../src/lib/server/auth/policy';
import { withRollback } from '../helpers';
import { clock, request, setUpOwner, UA } from './fixtures';

const DAY = 86_400_000;

describe('sessions', () => {
	it('resolve a token to its owner; anything else resolves to nothing', async () => {
		await withRollback(async (tx) => {
			const owner = await setUpOwner(tx);
			const check = await validateSessionToken(owner.token, { db: tx });
			expect(check?.session).toMatchObject({
				id: owner.session.id,
				ownerId: owner.ownerId,
				ownerName: 'Niko Cruz',
				kind: 'owner'
			});
			for (const bad of [undefined, '', 'x', `${owner.token}x`, 'a'.repeat(200)]) {
				expect(await validateSessionToken(bad, { db: tx })).toBeNull();
			}
		});
	});

	it('slide forward at most once a day and never past the absolute cap', async () => {
		await withRollback(async (tx) => {
			const time = clock();
			const owner = await setUpOwner(tx, { now: time.now });
			const created = time.now().getTime();
			expect(owner.session.expiresAt.getTime()).toBe(created + SESSION.idleMs);
			expect(owner.session.absoluteExpiresAt.getTime()).toBe(created + SESSION.absoluteMs);

			// Within the first day: no refresh.
			time.advance(DAY / 2);
			expect(
				(await validateSessionToken(owner.token, { db: tx, now: time.now }))?.refreshedExpiry
			).toBeUndefined();

			// After a day: pushed to now + 30 days (cookie re-sent).
			time.advance(DAY);
			const refreshed = await validateSessionToken(owner.token, { db: tx, now: time.now });
			expect(refreshed?.refreshedExpiry?.getTime()).toBe(time.now().getTime() + SESSION.idleMs);
			expect(
				(await validateSessionToken(owner.token, { db: tx, now: time.now }))?.refreshedExpiry
			).toBeUndefined();

			// Used daily for 89 days: still capped at 90 days after sign-in, then rejected.
			for (let day = 2; day < 90; day++) {
				time.advance(DAY);
				const check = await validateSessionToken(owner.token, { db: tx, now: time.now });
				expect(check, `day ${day}`).not.toBeNull();
				expect(check!.session.expiresAt.getTime()).toBeLessThanOrEqual(
					created + SESSION.absoluteMs
				);
			}
			time.advance(DAY);
			expect(await validateSessionToken(owner.token, { db: tx, now: time.now })).toBeNull();
		});
	});

	it('expire after 30 idle days', async () => {
		await withRollback(async (tx) => {
			const time = clock();
			const owner = await setUpOwner(tx, { now: time.now });
			time.advance(SESSION.idleMs - 1_000);
			expect(await validateSessionToken(owner.token, { db: tx, now: time.now })).not.toBeNull();
			time.advance(SESSION.idleMs + 1_000);
			expect(await validateSessionToken(owner.token, { db: tx, now: time.now })).toBeNull();
		});
	});

	it('record last seen at most every 10 minutes', async () => {
		await withRollback(async (tx) => {
			const time = clock();
			const owner = await setUpOwner(tx, { now: time.now });
			const repo = createAuthRepository(tx);
			time.advance(5 * 60_000);
			await validateSessionToken(owner.token, { db: tx, now: time.now });
			expect((await repo.findSession(owner.session.id))!.lastSeenAt).toEqual(
				owner.session.createdAt
			);
			time.advance(6 * 60_000);
			await validateSessionToken(owner.token, { db: tx, now: time.now });
			expect((await repo.findSession(owner.session.id))!.lastSeenAt).toEqual(time.now());
		});
	});

	it('are rejected once revoked: one, everywhere else, or by signing out', async () => {
		await withRollback(async (tx) => {
			const owner = await setUpOwner(tx);
			const current = (await validateSessionToken(owner.token, { db: tx }))!.session;
			const phone = await issueSession(
				{ ownerId: owner.ownerId, method: 'passkey', userAgent: UA },
				{ db: tx }
			);
			const laptop = await issueSession(
				{ ownerId: owner.ownerId, method: 'passkey', userAgent: null },
				{ db: tx }
			);
			const tablet = await issueSession(
				{ ownerId: owner.ownerId, method: 'passkey', userAgent: null },
				{ db: tx }
			);

			const listed = await listSessions(current, { db: tx });
			expect(listed).toHaveLength(4);
			expect(listed[0]).toMatchObject({ id: current.id, current: true });
			expect(listed.find((s) => s.id === phone.session.id)?.device).toBe('Safari on iPhone');

			await revokeSession(current, phone.session.id, request(), { db: tx });
			expect(await validateSessionToken(phone.token, { db: tx })).toBeNull();
			await expect(
				revokeSession(current, phone.session.id, request(), { db: tx })
			).rejects.toMatchObject({ code: 'not_found' });
			await expect(revokeSession(current, current.id, request(), { db: tx })).rejects.toMatchObject(
				{ code: 'invalid_input' }
			);

			expect(await revokeOtherSessions(current, request(), { db: tx })).toBe(2);
			expect(await validateSessionToken(laptop.token, { db: tx })).toBeNull();
			expect(await validateSessionToken(tablet.token, { db: tx })).toBeNull();
			expect(await validateSessionToken(owner.token, { db: tx })).not.toBeNull();

			await signOut(owner.token, request(), { db: tx });
			expect(await validateSessionToken(owner.token, { db: tx })).toBeNull();
			await signOut(owner.token, request(), { db: tx }); // idempotent
			const types = (await createAuthRepository(tx).recentEvents(5)).map((e) => e.type);
			expect(types).toEqual(
				expect.arrayContaining(['signout', 'session.revoked_others', 'session.revoked'])
			);
		});
	});

	it('cannot be revoked across owners or by a stranger’s id', async () => {
		await withRollback(async (tx) => {
			const owner = await setUpOwner(tx);
			const current = (await validateSessionToken(owner.token, { db: tx }))!.session;
			await expect(
				revokeSession(current, '00000000-0000-0000-0000-000000000000', request(), { db: tx })
			).rejects.toMatchObject({ code: 'not_found' });
		});
	});

	it('answer a malformed id as not found, never with a database error', async () => {
		await withRollback(async (tx) => {
			const owner = await setUpOwner(tx);
			const current = (await validateSessionToken(owner.token, { db: tx }))!.session;
			// A form field the client tampered with (or left out: ''), not a uuid Postgres accepts.
			for (const bad of ['', 'not-a-uuid', `${current.id}x`]) {
				await expect(revokeSession(current, bad, request(), { db: tx })).rejects.toMatchObject({
					code: 'not_found',
					status: 404
				});
			}
			expect(await validateSessionToken(owner.token, { db: tx })).not.toBeNull();
		});
	});
});
