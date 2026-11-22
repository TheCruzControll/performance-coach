/**
 * The periodisation-m3-weeks fixture (m7/38 week-kind-indicators): a program M3 built, stored as
 * M3's generator stored its plans (origin 'perfo-programming/1', M3's decision kinds in M3's own
 * words), so the week-kind line is shown to give a reason for a program no M7 decision explains.
 *
 * - First block (five weeks): a baseline week, three accumulation weeks and a deload, which is
 *   this week (week 5). M3's block_structure names the block.
 * - 'Run-up to the 5K' (four weeks): an accumulation week, the taper (week 7), race week (week 8),
 *   the race on its Saturday, and a deload (week 9). M3's event_taper names the taper week; no
 *   decision names the block or its deload, so that week gives WEEK_KIND_WHY's reason.
 *
 * Written through the real services at dates counted from the owner's today, with
 * periodisation-week-kinds.ts's helpers. TEST ONLY, like the rest of this folder.
 */
import { addDays, type IsoDate } from '../../../domain/calendar';
import { structureOf } from '../../../domain/programming/blocks';
import { DecisionLog } from '../../../domain/programming/decisions';
import type { ProgramPlan } from '../../../domain/training/types';
import type { WeekKind } from '../../../domain/training/vocabulary';
import { createProgramFromPlan } from '../../services/programs/index';
import type { AnalyticsFixture, FixtureResult } from './index';
import { blockOf, originOf, plannedWeek, profileWith } from './periodisation-week-kinds';

/** M3's generator id: the one it stored with every program it built. */
export const M3_GENERATOR = 'perfo-programming/1';

/** Each week by its number in the program. */
export const M3_WEEKS = { deload: 5, taper: 7, race: 8, lateDeload: 9 } as const;

export const M3_RACE = '5K race';

const FIRST: WeekKind[] = ['baseline', 'accumulation', 'accumulation', 'accumulation', 'deload'];
const RUN_UP: WeekKind[] = ['accumulation', 'taper', 'event', 'deload'];

export interface M3WeeksResult extends FixtureResult {
	/** The Monday of each named week. */
	mondays: Record<keyof typeof M3_WEEKS, IsoDate>;
	raceOn: IsoDate;
}

const m3Weeks: AnalyticsFixture = async (ctx): Promise<M3WeeksResult> => {
	const monday = (n: number) => addDays(ctx.weekStart, 7 * (n - M3_WEEKS.deload));
	const mondays = {
		deload: ctx.weekStart,
		taper: monday(M3_WEEKS.taper),
		race: monday(M3_WEEKS.race),
		lateDeload: monday(M3_WEEKS.lateDeload)
	};
	const raceOn = addDays(mondays.race, 5);
	const { goal, commitment } = await profileWith(ctx, M3_RACE, raceOn);
	const first = FIRST.map((kind, i) => plannedWeek(monday(i + 1), kind, commitment));
	const runUp = RUN_UP.map((kind, i) =>
		plannedWeek(monday(FIRST.length + i + 1), kind, commitment)
	);

	// M3's decisions, as blocks.ts writes them.
	const log = new DecisionLog();
	log.add('block_structure', 'blocks.default', ['blocks.0'], {
		block: 'First block',
		structure: structureOf(FIRST),
		weeks: FIRST.length,
		reason:
			'With no event date ahead, it is the standard start: a baseline week, three weeks that build on it and a deload that absorbs them.',
		notes: ''
	});
	log.add('event_taper', 'blocks.event_taper', ['blocks.1.weeks.1'], {
		event: M3_RACE,
		date: raceOn
	});
	const plan: ProgramPlan = {
		title: 'Strength, running and Muay Thai',
		startsOn: first[0]!.startsOn,
		firstPlannedDay: first[0]!.startsOn,
		blocks: [blockOf('First block', first, goal), blockOf('Run-up to the 5K', runUp, goal)],
		decisions: log.list()
	};
	const { programId } = await createProgramFromPlan(
		ctx.ownerId,
		plan,
		await originOf(ctx, M3_GENERATOR),
		{ db: ctx.db }
	);
	return {
		programId,
		historyStart: first[0]!.startsOn,
		exercises: {},
		workouts: {},
		lineages: {},
		mondays,
		raceOn
	};
};

export const fixtures = { 'periodisation-m3-weeks': m3Weeks } satisfies Record<
	string,
	AnalyticsFixture
>;
