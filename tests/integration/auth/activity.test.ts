import { describe, expect, it } from 'vitest';
import type { AuthEventType, Executor } from '../../../src/lib/server/db';
import { recentAuthActivity } from '../../../src/lib/server/auth/activity';
import { recordAuthEvent } from '../../../src/lib/server/auth/audit';
import {
	beginPasskeyRegistration,
	beginSignIn,
	completePasskeyRegistration,
	completeSignIn
} from '../../../src/lib/server/auth/passkeys';
import { redeemRecoveryCode, regenerateRecoveryCodes } from '../../../src/lib/server/auth/recovery';
import { validateSessionToken } from '../../../src/lib/server/auth/sessions';
import { withRollback } from '../helpers';
import { ORIGIN, request, RP, setUpOwner } from './fixtures';
import { SoftAuthenticator } from './soft-authenticator';

/** What anyone can do without credentials: ask to sign in and present a passkey of their own. */
async function failSignIns(tx: Executor, times: number) {
	const stranger = new SoftAuthenticator({ rpId: RP.rpID, origin: ORIGIN });
	for (let i = 0; i < times; i++) {
		const options = await beginSignIn(request(), { db: tx });
		await expect(
			completeSignIn(stranger.assert(options), undefined, request(), { db: tx })
		).rejects.toMatchObject({ code: 'unknown_credential' });
	}
}

const labels = (feed: { label: string }[]) => feed.map((e) => e.label);

/** Audit events as the email-link use-case writes them. */
async function record(tx: Executor, ownerId: string | null, ...types: AuthEventType[]) {
	for (const type of types) await recordAuthEvent(tx, request(), { type, ownerId });
}

describe('recent security activity', () => {
	it('folds each run of failed attempts into one row, so a flood hides nothing', async () => {
		await withRollback(async (tx) => {
			const owner = await setUpOwner(tx);
			const session = (await validateSessionToken(owner.token, { db: tx }))!.session;
			await failSignIns(tx, 2);
			await expect(
				redeemRecoveryCode('AAAA-AAAA-AAAA-AAAA', undefined, request(), { db: tx })
			).rejects.toMatchObject({ code: 'invalid_code' });
			await redeemRecoveryCode(owner.recoveryCodes[0], undefined, request(), { db: tx });
			await regenerateRecoveryCodes(session, request(), { db: tx });
			await failSignIns(tx, 25);

			const feed = await recentAuthActivity(session, 8, { db: tx });
			expect(labels(feed)).toEqual([
				'25 failed sign-in attempts',
				'New recovery codes created',
				'Recovery code used',
				'3 failed sign-in attempts',
				'Account set up'
			]);
			expect(feed[0]).toMatchObject({ tone: 'warning', device: 'Safari on iPhone' });
		});
	});

	it('says when a run reaches back further than it read', async () => {
		await withRollback(async (tx) => {
			const owner = await setUpOwner(tx);
			const session = (await validateSessionToken(owner.token, { db: tx }))!.session;
			await failSignIns(tx, 60);
			expect(labels(await recentAuthActivity(session, 8, { db: tx }))).toEqual([
				'50+ failed sign-in attempts',
				'Account set up'
			]);
		});
	});

	it('keeps the latest security changes in view however many routine events follow', async () => {
		await withRollback(async (tx) => {
			const owner = await setUpOwner(tx);
			const session = (await validateSessionToken(owner.token, { db: tx }))!.session;
			const laptop = new SoftAuthenticator({ rpId: RP.rpID, origin: ORIGIN });
			const options = await beginPasskeyRegistration(session, request(), { db: tx });
			await completePasskeyRegistration(session, laptop.register(options), request(), {
				db: tx
			});
			for (let i = 0; i < 10; i++) {
				const signIn = await beginSignIn(request(), { db: tx });
				await completeSignIn(laptop.assert(signIn), undefined, request(), { db: tx });
			}

			expect(labels(await recentAuthActivity(session, 8, { db: tx }))).toEqual([
				...Array(6).fill('Signed in with a passkey'),
				'Passkey added',
				'Account set up'
			]);
		});
	});

	it('keeps an email-link sign-in in view under a flood of refused links', async () => {
		await withRollback(async (tx) => {
			const owner = await setUpOwner(tx);
			const session = (await validateSessionToken(owner.token, { db: tx }))!.session;
			await record(tx, owner.ownerId, 'email_link.used');
			// Refused and expired links are attempts anyone can make: they fold into one run.
			for (let i = 0; i < 30; i++) {
				await record(tx, null, 'email_link.refused', 'email_link.expired');
			}

			const feed = await recentAuthActivity(session, 8, { db: tx });
			expect(labels(feed)).toEqual([
				'50+ failed sign-in attempts',
				'Signed in with an email link',
				'Account set up'
			]);
			expect(feed[0]).toMatchObject({ tone: 'warning' });
			expect(feed[1]).toMatchObject({ tone: 'neutral' });
		});
	});

	it('never shows a link being asked for or sent, nor lets those crowd the feed', async () => {
		await withRollback(async (tx) => {
			const owner = await setUpOwner(tx);
			const session = (await validateSessionToken(owner.token, { db: tx }))!.session;
			await failSignIns(tx, 3);
			for (let i = 0; i < 30; i++) {
				await record(tx, owner.ownerId, 'email_link.requested', 'email_link.sent');
			}
			expect(labels(await recentAuthActivity(session, 8, { db: tx }))).toEqual([
				'3 failed sign-in attempts',
				'Account set up'
			]);
		});
	});

	it('shows a sign-in email that could not be sent as a warning', async () => {
		await withRollback(async (tx) => {
			const owner = await setUpOwner(tx);
			const session = (await validateSessionToken(owner.token, { db: tx }))!.session;
			await record(tx, owner.ownerId, 'email_link.requested', 'email_link.send_failed');
			await record(tx, null, 'email_link.refused');
			const feed = await recentAuthActivity(session, 8, { db: tx });
			expect(feed.map(({ label, tone }) => [label, tone])).toEqual([
				['Email link refused', 'warning'],
				['Sign-in email couldn’t be sent', 'warning'],
				['Account set up', 'positive']
			]);
		});
	});
});
