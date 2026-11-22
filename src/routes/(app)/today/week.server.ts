/**
 * Today's 'This week' figures once onboarding is complete (services/analytics/week.ts), in words
 * (week-words.ts). Streamed beside the plan, so Today never waits for them on a client navigation;
 * the server's own render waits in +page.ts. Kept out of +page.server.ts so integration tests can
 * run it with an unreachable database.
 *
 * It fails soft: a read that fails is recorded as a server error (kind 'streamed') and resolves
 * to {failed: true}, which the tiles show as a designed error with Retry.
 */
import type { IsoDate } from '#lib/domain/calendar.ts';
import { getWeekSoFar } from '#lib/server/services/analytics/week.ts';
import { recordServerError } from '#lib/server/services/errors.ts';
import type { SetupDeps, SetupOrigin } from './setup.server';
import { weekView, type TodayWeekView } from './week-words';

/** Never rejects. */
export function loadTodayWeek(
	ownerId: string,
	{ today, origin }: { today: IsoDate; origin: SetupOrigin },
	{ db, errorsDb }: SetupDeps = {}
): Promise<TodayWeekView> {
	return getWeekSoFar(ownerId, { today }, { db })
		.then(weekView)
		.catch(async (error: unknown) => {
			await recordServerError(
				{ error, kind: 'streamed', status: 500, ...origin, context: { load: 'todayWeek' } },
				{ db: errorsDb }
			);
			return { failed: true } as const;
		});
}
