/**
 * Progress's 'This week' figures (services/analytics/week.ts), in words (week-words.ts). Streamed
 * beside the view, so Progress never waits for them on a client navigation; the server's own
 * render waits in +page.ts. Kept out of +page.server.ts so integration tests can run it with an
 * unreachable database.
 *
 * It fails soft: a read that fails is recorded as a server error (kind 'streamed') and resolves
 * to {failed: true}, which the tiles show as a designed error with Retry.
 */
import type { IsoDate } from '#lib/domain/calendar.ts';
import type { AthleteProfile } from '#lib/domain/profile/types.ts';
import { getWeekSoFar } from '#lib/server/services/analytics/week.ts';
import { recordServerError } from '#lib/server/services/errors.ts';
import type { ProgressDeps, ProgressRequest } from './load';
import { weekView, type WeekSoFarView } from './week-words';

/** Never rejects. `profile`: the one the route read to work out today, so it is not read again. */
export function loadWeekSoFar(
	ownerId: string,
	{
		today,
		profile,
		origin
	}: { today: IsoDate; profile?: AthleteProfile; origin: ProgressRequest['origin'] },
	{ db, errorsDb }: Pick<ProgressDeps, 'db' | 'errorsDb'> = {}
): Promise<WeekSoFarView> {
	return getWeekSoFar(ownerId, { today, profile }, { db })
		.then(weekView)
		.catch(async (error: unknown) => {
			await recordServerError(
				{ error, kind: 'streamed', status: 500, ...origin, context: { load: 'weekSoFar' } },
				{ db: errorsDb }
			);
			return { failed: true } as const;
		});
}
