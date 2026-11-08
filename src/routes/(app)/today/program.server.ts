/**
 * Whether the owner has a program yet, which picks Today's state once onboarding is complete:
 * 'none' shows the Build card over the summary, 'active' the program. Kept out of
 * +page.server.ts so integration tests can run it with an unreachable database.
 *
 * Decision (m3/42): it is awaited with the setup card, not streamed. A streamed state renders
 * the Build card only after hydration, which is the late largest paint m3/40 measured (~2.8 s)
 * for a streamed card; the check is two short reads.
 *
 * It returns the owner's today with the state, so Today's plan (plan.server.ts) reads at the
 * same day without asking for it again.
 *
 * It fails soft: a read that fails is recorded as a server error (kind 'load') and Today shows
 * its designed error with Retry, inside the shell, instead of the 500 page.
 */
import type { IsoDate } from '#lib/domain/calendar.ts';
import { ownerToday } from '#lib/server/local-date.ts';
import { recordServerError } from '#lib/server/services/errors.ts';
import { getCurrentProgram } from '#lib/server/services/programs/index.ts';
import type { SetupDeps, SetupOrigin } from './setup.server';

export type TodayProgram = 'none' | 'active';

export async function loadTodayProgram(
	ownerId: string,
	{ now, origin }: { now: Date; origin: SetupOrigin },
	{ db, errorsDb }: SetupDeps = {}
): Promise<{ state: TodayProgram; today: IsoDate } | null> {
	try {
		const today = await ownerToday(ownerId, now, { db });
		const state = (await getCurrentProgram(ownerId, today, { db })) ? 'active' : 'none';
		return { state, today };
	} catch (error) {
		await recordServerError(
			{ error, kind: 'load', status: 500, ...origin, context: { load: 'todayProgram' } },
			{ db: errorsDb }
		);
		return null;
	}
}
