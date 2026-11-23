import { version } from '$app/env';
import { listPasskeys } from '#lib/server/auth/index.ts';
import { ownerId } from '#lib/server/forms/profile.ts';
import { recordServerError } from '#lib/server/services/errors.ts';
import { findTrainingProfile } from '#lib/server/services/profile/index.ts';
import { passkeysAnswer, sectionAnswers, type ProfileAnswers } from '#lib/ui/profile/answers.ts';
import type { LayoutServerLoad } from './$types';

/**
 * Profile's list, with each row's answer: Profile, every section screen at a desk (and later
 * Appearance and Past goals) show it, so the layout reads it once and keeps it while the owner
 * moves between them. A save invalidates `app:profile-answers`.
 */
export const load: LayoutServerLoad = ({ locals, request, url, route, depends, untrack }) => {
	depends('app:profile-answers');
	const owner = ownerId(locals);
	// Streamed, and read-only (findTrainingProfile never writes): the load does not wait for it.
	// The response has already started, so handleError never sees a streamed failure: a failure
	// is recorded and the rows show their titles alone.
	const answers: Promise<ProfileAnswers | null> = Promise.all([
		findTrainingProfile(owner),
		locals.session ? listPasskeys(locals.session) : Promise.resolve([])
	])
		.then(([profile, passkeys]) => ({
			sections: profile ? sectionAnswers(profile) : {},
			passkeys: passkeysAnswer(passkeys.length)
		}))
		.catch(async (error: unknown) => {
			// Read without tracking: the path and route would rerun this load on every section.
			const where = untrack(() => ({ path: url.pathname, routeId: route.id }));
			await recordServerError({
				error,
				kind: 'streamed',
				status: 500,
				requestId: locals.requestId,
				method: request.method,
				path: where.path,
				routeId: where.routeId,
				appVersion: version,
				context: { load: 'profileAnswers' }
			});
			return null;
		});
	return { answers };
};
