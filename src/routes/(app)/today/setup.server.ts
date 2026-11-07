/**
 * Today's setup card: until onboarding is complete, how far the owner has got and where Continue
 * resumes (the furthest step advanced). Kept out of +page.server.ts so integration tests can run
 * it with an unreachable database.
 *
 * - `done` counts the finished (completed or skipped) steps among those that apply now, and
 *   `total` is every step that applies, review included, as onboarding's own progress counts.
 * - It fails soft: Today streams it, so a read that fails is recorded as a server error (kind
 *   'streamed', since the response has already started) and the card shows its designed error.
 */
import type { OnboardingStep } from '#lib/domain/profile/onboarding.ts';
import { recordServerError, type ServerErrorInput } from '#lib/server/services/errors.ts';
import { getOnboarding, type ProfileDeps } from '#lib/server/services/profile/index.ts';

export type TodaySetup =
	{ complete: true } | { complete: false; done: number; total: number; next: OnboardingStep };

export type SetupOrigin = Pick<
	ServerErrorInput,
	'requestId' | 'method' | 'path' | 'routeId' | 'appVersion'
>;

export interface SetupDeps extends Pick<ProfileDeps, 'db'> {
	/** Where a failure is recorded (app_errors): the app's database unless given. */
	errorsDb?: ProfileDeps['db'];
}

export async function loadTodaySetup(
	ownerId: string,
	origin: SetupOrigin,
	{ db, errorsDb }: SetupDeps = {}
): Promise<TodaySetup | null> {
	try {
		const { complete, steps, progress, resume } = await getOnboarding(ownerId, { db });
		if (complete) return { complete: true };
		const finished = new Set([...progress.completed, ...progress.skipped]);
		return {
			complete: false,
			done: steps.filter((step) => finished.has(step)).length,
			total: steps.length,
			next: resume
		};
	} catch (error) {
		await recordServerError(
			{ error, kind: 'streamed', status: 500, ...origin, context: { load: 'todaySetup' } },
			{ db: errorsDb }
		);
		return null;
	}
}
