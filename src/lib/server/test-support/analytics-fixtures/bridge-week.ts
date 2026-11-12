/**
 * The bridge-week fixture (M6 bridge-week-states): a program whose current week is a 'Between
 * blocks' bridge week, as a late cycle review leaves one, for the specs and the integration test
 * of the bridge's states on Train, the plan timeline, History and Today.
 *
 * - Base, the review fixtures' four-week block (reviews.ts), ended the Sunday BRIDGE_WEEKS weeks
 *   before this week ends, every session logged.
 * - Its next block was planned late through planBlock, starting next Monday (next-block/dates.ts):
 *   the weeks since Base are a bridge of BRIDGE_WEEKS unplanned weeks with no sessions (version
 *   2), this week its last, and Build (NEXT_BLOCK_WEEKS weeks of Base's week) starts next Monday.
 * - One easy run is logged in this week of the bridge, off-plan (workouts.offPlan), started early
 *   enough today that it is over by `now`.
 *
 * Its result names the next block: `nextBlock.startsOn` and the program week it starts in.
 * TEST ONLY, like the rest of this folder.
 */
import { addDays, daysBetween, type IsoDate } from '../../../domain/calendar';
import { nextBlockDates } from '../../../domain/programming/next-block/dates';
import { bridgeBlock } from '../../../domain/programming/stages/next-shape';
import { APPEND, getProgramVersion, planBlock } from '../../services/programs/index';
import { finishWorkout, logRun, startWorkout } from '../../services/training/log';
import { atLocal } from './dashboards';
import type { AnalyticsFixture, FixtureResult, SeedContext } from './index';
import { block, BLOCK_WEEKS, seedLayout, TARGET_RPE, week, weekSessions } from './reviews';

/** Unplanned weeks between Base and Build, this week the last of them. */
export const BRIDGE_WEEKS = 3;
/** Build's length, from next Monday. */
export const NEXT_BLOCK_WEEKS = 4;
/** The off-plan run: its length, and the distance logged. */
const RUN_MINUTES = 30;
const RUN_METRES = 5000;

export interface BridgeFixtureResult extends FixtureResult {
	/** The block after the bridge: its first day, and its first week's number in the program. */
	nextBlock: { startsOn: IsoDate; week: number };
}

/** An easy run logged today with no planned session: over by `now`, never before 00:05. */
async function logOffPlanRun(ctx: SeedContext): Promise<string> {
	const deps = { db: ctx.db };
	const latest = ctx.now.getTime() - (RUN_MINUTES + 5) * 60_000;
	const floor = atLocal(ctx.today, '00:05', ctx.timeZone).getTime();
	const usual = atLocal(ctx.today, '07:00', ctx.timeZone).getTime();
	const at = new Date(Math.max(floor, Math.min(usual, latest)));
	const clientId = crypto.randomUUID();
	const started = {
		...{ clientId, kind: 'run', discipline: 'running', sessionType: 'easy_run' },
		...{ title: 'Easy run', plannedSessionId: null, startedAt: at.toISOString() }
	};
	const { workout } = await startWorkout(ctx.ownerId, started, deps);
	const distance = { value: RUN_METRES, unit: 'm' };
	const seconds = RUN_MINUTES * 60;
	const segment = { clientMutationId: crypto.randomUUID(), position: 1, kind: 'easy' };
	const run = {
		...{ workoutClientId: clientId, distance, durationSeconds: seconds, avgHr: null, rpe: 4 },
		notes: null,
		segments: [{ ...segment, distance, durationSeconds: seconds, avgHr: null, rpe: null }]
	};
	await logRun(ctx.ownerId, run, deps);
	const finishedAt = new Date(at.getTime() + seconds * 1000).toISOString();
	const done = { status: 'completed', finishedAt, durationSeconds: seconds, sessionRpe: 4 };
	await finishWorkout(ctx.ownerId, clientId, done, deps);
	return workout.id;
}

const bridgeWeek: AnalyticsFixture = async (ctx): Promise<BridgeFixtureResult> => {
	const deps = { db: ctx.db };
	const layout = { first: 1 - BLOCK_WEEKS - BRIDGE_WEEKS, lastKind: 'accumulation' } as const;
	const { result, block: base } = await seedLayout(ctx, layout);
	const programId = result.programId!;
	const v1 = await getProgramVersion(ctx.ownerId, programId, 1, deps);
	const dates = nextBlockDates({
		...{ blocks: v1.blocks, reviewedBlock: 0, today: ctx.today, start: 'next_monday' },
		...{ events: [], weeks: NEXT_BLOCK_WEEKS }
	});
	if (dates.bridge?.weeks !== BRIDGE_WEEKS) throw new Error('bridge-week: no bridge to plan');
	const commitment = base.weeks[0]!.sessions.find((s) => s.commitmentRef)!.commitmentRef!;
	const weeks = Array.from({ length: dates.block.weeks }, (_, i) => {
		const monday = addDays(dates.block.startsOn, 7 * i);
		return week(monday, 'accumulation', weekSessions(monday, TARGET_RPE, commitment));
	});
	await planBlock(
		ctx.ownerId,
		{
			baseVersionNumber: 1,
			blockLineage: APPEND,
			bridge: bridgeBlock(dates.bridge),
			block: block('Build', weeks, base.goalRefs[0]!),
			shifted: [],
			firstPlannedDay: dates.firstPlannedDay,
			decisions: [
				{
					kind: 'next_block_planned',
					ruleKey: 'next_block.planned',
					summary: 'Build is planned from next Monday',
					why: 'Bridge fixture: the cycle review came three weeks late.',
					decidedBy: 'rules',
					refs: ['blocks.0'],
					evidence: {}
				}
			],
			createdBy: 'rules',
			summary: 'Build planned after three weeks between blocks',
			origin: { generator: null }
		},
		deps
	);
	const offPlan = await logOffPlanRun(ctx);
	const startsOn = dates.block.startsOn;
	return {
		...result,
		workouts: { ...result.workouts, offPlan },
		nextBlock: { startsOn, week: daysBetween(v1.startsOn, startsOn) / 7 + 1 }
	};
};

export const fixtures = { 'bridge-week': bridgeWeek } satisfies Record<string, AnalyticsFixture>;
