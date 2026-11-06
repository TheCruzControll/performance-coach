import { describe, expect, it } from 'vitest';
import type { Executor } from '../../../src/lib/server/db';
import { recentAuthActivity } from '../../../src/lib/server/auth/activity';
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
});
