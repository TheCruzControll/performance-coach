import { version } from '$app/env';
import { STEP_INFO } from '#lib/domain/profile/onboarding.ts';
import { getEnv } from '#lib/server/env.ts';
import { ownerId } from '#lib/server/forms/profile.ts';
import { logWhenSettled } from '#lib/server/observability/timing.ts';
import { recordServerError } from '#lib/server/services/errors.ts';
import { checkHealth } from '#lib/server/services/health.ts';
import { getAthleteProfile, getOnboarding } from '#lib/server/services/profile/index.ts';
import { getVitalsSummary } from '#lib/server/services/vitals.ts';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, request, url, route }) => {
	// Streamed: the page renders immediately and these fill in when ready.
	const health = checkHealth({ version, timeoutMs: 1500 });
	// The response has already started, so handleError never sees a streamed failure: the card
	// degrades (to "no samples", or no setup row), and the failure is logged and recorded like
	// any server error.
	const failSoft = (load: string) => async (error: unknown) => {
		await recordServerError({
			error,
			kind: 'streamed',
			status: 500,
			requestId: locals.requestId,
			method: request.method,
			path: url.pathname,
			routeId: route.id,
			appVersion: version,
			context: { load }
		});
		return null;
	};
	const vitals = getVitalsSummary(7).catch(failSoft('getVitalsSummary'));
	// Until onboarding is complete, Training profile offers to continue it at the furthest step
	// advanced (as Today's setup card does), named here so the page ships no step table.
	const setup = getOnboarding(ownerId(locals))
		.then(({ complete, resume }) =>
			complete ? null : { resume, stoppedAt: resume === 'welcome' ? null : STEP_INFO[resume].title }
		)
		.catch(failSoft('getOnboarding'));
	logWhenSettled(route.id, [health, vitals, setup]);
	// The name the coach uses (Profile → Name & units) heads the screen; the passkey's owner name
	// is what it starts from.
	const athlete = await getAthleteProfile(ownerId(locals));

	return {
		version,
		appEnv: getEnv().appEnv,
		owner: { name: athlete.name || (locals.session?.ownerName ?? 'Owner') },
		health,
		vitals,
		setup
	};
};
