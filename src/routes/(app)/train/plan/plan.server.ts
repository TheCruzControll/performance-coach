/**
 * What the whole plan (/train/plan, v2/07b) renders on the server: the current program's title,
 * its length and last day ('14 weeks, ending Sunday 7 February') and one line per block
 * (week-lines.ts phaseLines): its weeks, done before the block that holds today, now for that one,
 * all done once the plan has ended. Kept out of +page.server.ts so integration tests can run it.
 *
 * - With no program there is no plan to show: 'none', which +page.server.ts sends to Train.
 * - It fails soft, as Train's load does: a read that fails is recorded as a server error (kind
 *   'load', context { load: 'plan' }) and the page shows Train's "Couldn't load your plan" with
 *   Try again, inside the shell, instead of the 500 page.
 */
import { daysBetween } from '#lib/domain/calendar.ts';
import { ownerToday } from '#lib/server/local-date.ts';
import { recordServerError } from '#lib/server/services/errors.ts';
import { getCurrentProgram } from '#lib/server/services/programs/index.ts';
import { timelineView } from '#lib/ui/program/timeline.ts';
import { phaseLines, planSpan, type PhaseLine } from '#lib/ui/program/week-lines.ts';
import { ERROR_CARD, type StateCard } from '../cards.server';
import type { TrainLoadDeps, TrainRequest } from '../week.server';

export type PlanData =
	| { state: 'none' }
	| { state: 'error'; card: StateCard }
	| {
			state: 'plan';
			/** The program's title: 'Strength, running and Muay Thai'. */
			title: string;
			/** '14 weeks, ending Sunday 7 February'. */
			span: string;
			phases: PhaseLine[];
	  };

export async function loadPlan(
	ownerId: string,
	{ now, origin }: Pick<TrainRequest, 'now' | 'origin'>,
	{ db, errorsDb }: Pick<TrainLoadDeps, 'db' | 'errorsDb'> = {}
): Promise<PlanData> {
	try {
		const today = await ownerToday(ownerId, now, { db });
		const program = await getCurrentProgram(ownerId, today, { db });
		if (!program) return { state: 'none' };
		// The lines read each block's name, weeks and whether it holds today: no goal's event, so
		// no goals are read.
		const blocks = timelineView(program, { today, goals: [] });
		const lastDay = program.blocks.reduce((end, b) => (b.endsOn > end ? b.endsOn : end), '');
		const weeks = (daysBetween(program.startsOn, lastDay) + 1) / 7;
		return {
			state: 'plan',
			title: program.title,
			span: planSpan(weeks, lastDay),
			phases: phaseLines(blocks, today > lastDay)
		};
	} catch (error) {
		await recordServerError(
			{ error, kind: 'load', status: 500, ...origin, context: { load: 'plan' } },
			{ db: errorsDb }
		);
		return { state: 'error', card: ERROR_CARD };
	}
}
