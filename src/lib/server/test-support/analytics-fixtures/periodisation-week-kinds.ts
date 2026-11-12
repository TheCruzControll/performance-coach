/**
 * The periodisation-week-kinds fixture (m7/38 week-kind-indicators): an M7-built program whose
 * current week is a deload and whose week after next is a taper before a race, for the week-kind
 * line on Train and Today, its integration test and its spec. Written through the real services
 * (M2's profile, M3's program store and its move edit) at dates counted from the owner's today,
 * so it holds on any weekday.
 *
 * - One block, 'Run-up to the 10K' (five weeks): last week (week 1, accumulation), this week
 *   (week 2, a deload), next week (week 3, accumulation), the taper (week 4) and race week (week
 *   5), the race on its Saturday; then an outline block.
 * - Every week is reviews.ts's week: two strength sessions, a Tuesday Muay Thai class (the
 *   owner's commitment), sparring and two runs.
 * - M7's decisions, in their own words (decisions/templates): the block's type (block_type_chosen)
 *   and its taper (taper_planned), both naming the block, as season.ts writes them, and this
 *   week's deload (deload_scheduled), naming the week.
 * - Next week's long run moved from Saturday to Sunday (version 2, M3's moveSession), so version
 *   1 is an older version, read-only in History.
 *
 * The helpers below (profileWith, plannedWeek) are periodisation-m3-weeks.ts's too.
 * TEST ONLY, like the rest of this folder.
 */
import { addDays, type IsoDate } from '../../../domain/calendar';
import { CATALOGUE } from '../../../domain/exercises/index';
import { buildProgrammingInput, catalogueDigest, GENERATOR_ID } from '../../../domain/programming';
import { DecisionLog } from '../../../domain/programming/decisions';
import type { BlockPlan, ProgramPlan, WeekPlan } from '../../../domain/training/types';
import type { WeekKind } from '../../../domain/training/vocabulary';
import { createGoal, getTrainingProfile, saveSchedule } from '../../services/profile/index';
import { moveSession } from '../../services/programs/edits';
import { createProgramFromPlan, getProgramVersion } from '../../services/programs/index';
import type { AnalyticsFixture, FixtureResult, SeedContext } from './index';
import { weekSessions } from './reviews';

/** Each week by its number in the program. */
export const KIND_WEEKS = { past: 1, deload: 2, next: 3, taper: 4, race: 5 } as const;

/** The race, on race week's Saturday. */
export const RACE_TITLE = '10K race';

export interface WeekKindsResult extends FixtureResult {
	/** The Monday of each fixture week, by name. */
	mondays: Record<keyof typeof KIND_WEEKS, IsoDate>;
	/** The event's day. */
	raceOn: IsoDate;
}

const LIGHT: Partial<Record<WeekKind, number>> = { deload: 6, taper: 7, event: 6, recovery: 5 };

/** A planned week of `kind` from `monday`: reviews.ts's sessions, lighter in a light week. */
export function plannedWeek(monday: IsoDate, kind: WeekKind, commitment: string): WeekPlan {
	const rpe = LIGHT[kind] ?? 8;
	const light = rpe < 8;
	return {
		kind,
		startsOn: monday,
		endsOn: addDays(monday, 6),
		targets: {
			...{ rpeCap: rpe, volumeFactor: light ? 0.6 : 1 },
			...{ loadStep: light ? -0.1 : 0.025, runVolumeFactor: light ? 0.7 : 1 }
		},
		sessions: weekSessions(monday, rpe, commitment)
	};
}

export const blockOf = (
	name: string,
	weeks: WeekPlan[],
	goal: string,
	outline = false
): BlockPlan => ({
	...{ phase: 'accumulation', name, startsOn: weeks[0]!.startsOn, endsOn: weeks.at(-1)!.endsOn },
	...{ outline, goalRefs: [goal], weeks },
	progression: outline ? {} : { rpeStepPerWeek: 0.5, rpeCap: 8.5 }
});

/** An event goal on `eventOn` and the Tuesday class: the goal's and the commitment's ids. */
export async function profileWith(ctx: SeedContext, title: string, eventOn: IsoDate) {
	const deps = { db: ctx.db };
	const goal = await createGoal(
		ctx.ownerId,
		{ kind: 'event', title, disciplines: ['running'], eventType: title, eventDate: eventOn },
		deps
	);
	const commitment = {
		...{ discipline: 'muay_thai', label: 'Muay Thai class', days: ['tue'] },
		...{ timeOfDay: 'evening', durationMinutes: 90, intensity: 'hard', notes: null }
	};
	const schedule = await saveSchedule(
		ctx.ownerId,
		{
			daysPerWeek: 6,
			availableDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
			preferredTimes: ['morning', 'evening'],
			sessionMinutes: 60,
			commitments: [commitment]
		},
		deps
	);
	return { goal: goal.id, commitment: schedule.commitments[0]!.id };
}

/** The profile's generator input, stored as the program's origin, with `generator`'s id. */
export async function originOf(ctx: SeedContext, generator: string) {
	const input = buildProgrammingInput(await getTrainingProfile(ctx.ownerId, { db: ctx.db }), {
		catalogue: CATALOGUE
	});
	return {
		source: 'rules' as const,
		generator,
		digest: catalogueDigest(CATALOGUE, []),
		snapshot: input as unknown as Record<string, unknown>
	};
}

const weekKinds: AnalyticsFixture = async (ctx): Promise<WeekKindsResult> => {
	const deps = { db: ctx.db };
	const monday = (n: number) => addDays(ctx.weekStart, 7 * (n - KIND_WEEKS.deload));
	const mondays = {
		past: monday(KIND_WEEKS.past),
		deload: ctx.weekStart,
		next: monday(KIND_WEEKS.next),
		taper: monday(KIND_WEEKS.taper),
		race: monday(KIND_WEEKS.race)
	};
	const raceOn = addDays(mondays.race, 5);
	const { goal, commitment } = await profileWith(ctx, RACE_TITLE, raceOn);
	const kinds: [IsoDate, WeekKind][] = [
		[mondays.past, 'accumulation'],
		[mondays.deload, 'deload'],
		[mondays.next, 'accumulation'],
		[mondays.taper, 'taper'],
		[mondays.race, 'event']
	];
	const weeks = kinds.map(([m, kind]) => plannedWeek(m, kind, commitment));
	const after = addDays(mondays.race, 7);
	const outline = [0, 1].map((i) => ({
		...plannedWeek(addDays(after, 7 * i), 'accumulation', commitment),
		sessions: []
	}));

	const log = new DecisionLog();
	log.add('block_type_chosen', 'season.event_run_up', ['blocks.0'], {
		block: 'Run-up to the 10K',
		type: 'Strength',
		weeks: weeks.length,
		startsOn: mondays.past,
		reason: `${RACE_TITLE} on ${raceOn} leads, so the block builds to it.`
	});
	log.add('taper_planned', 'taper.short_race', ['blocks.0'], {
		event: RACE_TITLE,
		date: raceOn,
		length: '1 week',
		steps: '70 % of the volume',
		reason: 'A short race needs one lighter week.'
	});
	log.add('deload_scheduled', 'deload.cadence', ['blocks.0.weeks.1'], {
		week: KIND_WEEKS.deload,
		rpeCap: LIGHT.deload!,
		reason: 'It comes after the loading weeks, three weeks before the taper.'
	});
	const plan: ProgramPlan = {
		title: 'Run-up to the 10K',
		startsOn: mondays.past,
		firstPlannedDay: mondays.past,
		blocks: [blockOf('Run-up to the 10K', weeks, goal), blockOf('Build', outline, goal, true)],
		decisions: log.list()
	};
	const { programId } = await createProgramFromPlan(
		ctx.ownerId,
		plan,
		await originOf(ctx, GENERATOR_ID),
		deps
	);

	const v1 = await getProgramVersion(ctx.ownerId, programId, 1, deps);
	const next = v1.blocks[0]!.weeks[KIND_WEEKS.next - 1]!;
	const longRun = next.sessions.find((s) => s.title === 'Long run')!;
	await moveSession(
		ctx.ownerId,
		{
			sessionLineage: longRun.lineage,
			toDate: addDays(mondays.next, 6),
			reason: 'Saturday is busy'
		},
		{ version: 1, today: ctx.today },
		{ ...deps, now: () => ctx.now, source: 'owner' }
	);
	return {
		programId,
		historyStart: mondays.past,
		exercises: {},
		workouts: {},
		lineages: { moved: longRun.lineage },
		mondays,
		raceOn
	};
};

export const fixtures = { 'periodisation-week-kinds': weekKinds } satisfies Record<
	string,
	AnalyticsFixture
>;
