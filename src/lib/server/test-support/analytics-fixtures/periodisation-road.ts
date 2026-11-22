/**
 * The periodisation-road fixtures (m7/39 periodisation-timeline): programs the generator builds
 * from M7's scenario profiles, stored as a build stores them (its generator and its input
 * snapshot), for the season on Train's plan sheet, its integration test and its spec.
 *
 * - periodisation-road: multiGoal (S1), built by the M7 generator: a fight camp, then the
 *   marathon's road in outline to both events, each block's goal roles in its decisions.
 * - periodisation-road-m3: M3's hybrid, its mode decisions left out, as a program built before M7
 *   stores none: its roles are worked out from its goals.
 * - periodisation-road-off-season: offSeason, keep goals only: maintenance blocks, no event.
 *
 * The scenario's dates move by whole weeks so its week 1 is the owner's this week, and each goal
 * is written as the owner's own through M2's createGoal, in rank order, so the plan's refs, Train's
 * events and its open-goal count all name them. TEST ONLY, like the rest of this folder.
 */
import { addDays, daysBetween } from '../../../domain/calendar';
import { CATALOGUE } from '../../../domain/exercises/index';
import type { Goal, TrainingProfile } from '../../../domain/profile/types';
import { buildProgrammingInput, catalogueDigest, GENERATOR_ID } from '../../../domain/programming';
import { generateProgram } from '../../../domain/programming/generate';
import { M7_SCENARIOS } from '../../../domain/programming/periodisation/scenarios';
import { SCENARIO_START, SCENARIOS } from '../../../domain/programming/scenarios';
import { MODE_KINDS } from '../../services/periodisation/road-view';
import { createGoal } from '../../services/profile/index';
import { createProgramFromPlan } from '../../services/programs/index';
import type { AnalyticsFixture, FixtureResult, SeedContext } from './index';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** `value` with every calendar date in it `days` later (Dates, the store's instants, kept). */
function shifted<T>(value: T, days: number): T {
	if (typeof value === 'string') return (ISO_DAY.test(value) ? addDays(value, days) : value) as T;
	if (Array.isArray(value)) return value.map((v: unknown) => shifted(v, days)) as T;
	if (value && typeof value === 'object' && !(value instanceof Date)) {
		const entries = Object.entries(value).map(([k, v]) => [k, shifted(v, days)]);
		return Object.fromEntries(entries) as T;
	}
	return value;
}

/** A goal as M2's form sends it; M3's general goals left their measure blank. */
const formOf = (g: Goal) =>
	g.kind === 'event'
		? {
				kind: 'event',
				title: g.title,
				disciplines: g.disciplines,
				eventType: g.eventType,
				eventDate: g.eventDate
			}
		: {
				kind: 'general',
				title: g.title,
				disciplines: g.disciplines,
				focus: g.focus ?? g.title,
				measure: g.measure ?? 'Top sets at RPE 8 hold or rise',
				targetDate: g.targetDate
			};

async function seedRoad(
	ctx: SeedContext,
	scenario: () => TrainingProfile,
	{ m3 = false } = {}
): Promise<FixtureResult> {
	const deps = { db: ctx.db };
	const profile = shifted(scenario(), daysBetween(SCENARIO_START, ctx.weekStart));
	const ids: string[] = [];
	for (const goal of profile.goals)
		ids.push((await createGoal(ctx.ownerId, formOf(goal), deps)).id);
	profile.goals = profile.goals.map((g, i) => ({ ...g, id: ids[i]! }));

	const input = buildProgrammingInput(profile, { catalogue: CATALOGUE });
	const plan = generateProgram(input, { startsOn: ctx.weekStart, firstPlannedDay: ctx.weekStart });
	const modes: readonly string[] = MODE_KINDS;
	const decisions = m3 ? plan.decisions.filter((d) => !modes.includes(d.kind)) : plan.decisions;
	const { programId } = await createProgramFromPlan(
		ctx.ownerId,
		{ ...plan, decisions },
		{
			source: 'rules',
			generator: GENERATOR_ID,
			digest: catalogueDigest(CATALOGUE, []),
			snapshot: input as unknown as Record<string, unknown>
		},
		deps
	);
	return { programId, historyStart: ctx.weekStart, exercises: {}, workouts: {}, lineages: {} };
}

export const fixtures = {
	'periodisation-road': (ctx) => seedRoad(ctx, M7_SCENARIOS.multiGoal),
	'periodisation-road-m3': (ctx) => seedRoad(ctx, SCENARIOS.hybrid, { m3: true }),
	'periodisation-road-off-season': (ctx) => seedRoad(ctx, M7_SCENARIOS.offSeason)
} satisfies Record<string, AnalyticsFixture>;
