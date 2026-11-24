import { STEP_INFO } from '#lib/domain/profile/onboarding.ts';
import { ownerId } from '#lib/server/forms/profile.ts';
import { getOnboarding } from '#lib/server/services/profile/index.ts';
import { aboutData, failSoftFor } from './about.server';
import type { PageServerLoad } from './$types';

/**
 * Profile: the list (its answers stream from the layout's load), "Finish setting up" while
 * onboarding is unfinished, and About this app (./about.server.ts): its row's answer, and the open
 * side at a desk.
 */
export const load: PageServerLoad = async (event) => {
	const { locals } = event;
	// Until onboarding is complete, Profile offers to finish it at the furthest step advanced (as
	// Today's setup card does), named here so the page ships no step table. Streamed: nothing
	// until it settles, and nothing if the read failed.
	const setup = getOnboarding(ownerId(locals))
		.then(({ complete, resume }) =>
			complete ? null : { resume, stoppedAt: resume === 'welcome' ? null : STEP_INFO[resume].title }
		)
		.catch(failSoftFor(event)('getOnboarding'));
	const { athlete, ...about } = await aboutData(event, [setup]);

	return {
		...about,
		// The name the coach uses (Profile → Name and units) sits under the title; the passkey's
		// owner name is what it starts from.
		owner: { name: athlete.name || (locals.session?.ownerName ?? 'Owner') },
		setup
	};
};
