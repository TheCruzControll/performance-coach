/**
 * The season for Train's plan sheet (m7/39 periodisation-timeline): the owner's periodisation road
 * (services/periodisation/road-view.ts) in the season's words (ui/program/season.ts), streamed by
 * +page.server.ts after the week, so Train paints without waiting for it and the lazy sheet shows
 * M3's timeline until it arrives. Kept out of +page.server.ts so integration tests can run it.
 *
 * It never rejects: a read that fails is recorded as a streamed server error (part 'road') and
 * answers null, and the sheet keeps M3's timeline. The test route's fault (road-faults.ts) holds
 * or fails it, only where test routes are enabled.
 */
import type { IsoDate } from '#lib/domain/calendar.ts';
import { recordServerError } from '#lib/server/services/errors.ts';
import { roadFault, roadReleased } from '#lib/server/services/periodisation/road-faults.ts';
import { getRoadView } from '#lib/server/services/periodisation/road-view.ts';
import { seasonView, type SeasonView } from '#lib/ui/program/season.ts';
import type { TrainLoadDeps, TrainRequest } from './week.server';

export async function loadTrainRoad(
	ownerId: string,
	{ today, origin }: { today: IsoDate } & Pick<TrainRequest, 'origin'>,
	{ db, errorsDb }: Pick<TrainLoadDeps, 'db' | 'errorsDb'> = {}
): Promise<SeasonView | null> {
	try {
		const fault = roadFault();
		if (fault === 'slow') await roadReleased();
		if (fault === 'fail') throw new Error('test fault: the road read failed');
		const road = await getRoadView(ownerId, today, { db });
		return road && seasonView(road, today);
	} catch (error) {
		const context = { load: 'train', part: 'road' };
		await recordServerError(
			{ error, kind: 'streamed', status: 500, ...origin, context },
			{ db: errorsDb }
		);
		return null;
	}
}
