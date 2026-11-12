/**
 * Review fixtures whose weekly review, and its next-week proposal, are already stored through the
 * real service (M6 review-adjustments-ui): the review screen's next-week card starts from them.
 * Bench gets a second line at a fixed 85 kg on next week's Monday and Thursday (inserted beside
 * the RPE-based one, as the review services' integration tests do, since history rows are never
 * updated), so next week's proposal holds a bench +2.5 kg change with a half step on each day,
 * beside whatever else the rules propose.
 *
 * - review-ahead: this week reviewed early, every session logged, today's included (the
 *   week-almost-complete layout with today's run logged too, inside a block that runs one week
 *   longer): next week is the next calendar week, planned, and every change in it is still ahead
 *   on any weekday.
 * - review-aged: week-complete (last week reviewed, the hard week) with its review and proposal
 *   created on this week's Monday, before any of this week was logged. Every session of this week
 *   dated before today has passed since; on a Monday, today's Strength A is logged after the
 *   review, so its change has started and is dropped all the same. Late in the week (Saturday,
 *   Sunday) every change has passed.
 *
 * Each returns `review` (the week reviewed and its next week) and `lineages.benchMonday` and
 * `lineages.benchThursday`: next week's two strength sessions with the fixed bench line.
 * TEST ONLY, like the rest of this folder.
 */
import { sql } from 'drizzle-orm';
import { addDays, type IsoDate } from '../../../domain/calendar';
import { resolveKeys } from '../../services/exercises/index';
import { getCurrentProgram, getProgramVersion } from '../../services/programs/index';
import { createWeeklyReview } from '../../services/reviews/index';
import { atLocal } from './dashboards';
import type { AnalyticsFixture, SeedContext } from './index';
import {
	BLOCK_WEEKS,
	KEYS,
	logSession,
	weekly,
	type Key,
	type Layout,
	type ReviewFixtureResult
} from './reviews';

/** The fixed bench line both days get: 3 × 5 at 85 kg, RPE 8. */
export const FIXED_BENCH_KG = 85;

/** review-ahead's block: its first week, so that this week is its third and next week its last. */
const AHEAD: Layout = {
	first: 2 - BLOCK_WEEKS,
	lastKind: 'accumulation',
	cut: true,
	today: 'all',
	// Last week and this one: bench is easier in its last three exposures on any weekday.
	hard: [-1, 0]
};
const AGED: Layout = { first: 1 - BLOCK_WEEKS, lastKind: 'accumulation', outline: true, hard: -1 };

/** Add the fixed bench line to the current version's bench on `date`; that session's lineage. */
async function fixedBench(ctx: SeedContext, date: IsoDate): Promise<string> {
	const bench = (await resolveKeys(['bench_press'], { db: ctx.db })).get('bench_press')!.id;
	const { rows } = await ctx.db.execute<{ id: string; lineage: string }>(
		sql`select pe.id::text as id, ps.lineage_id::text as lineage from planned_exercises pe
			join planned_sessions ps on ps.id = pe.session_id
			join program_version_weeks vw on vw.week_id = ps.week_id
			join programs p on p.current_version_id = vw.version_id
			where p.owner_id = ${ctx.ownerId} and ps.scheduled_on = ${date} and pe.exercise_id = ${bench}`
	);
	if (rows.length !== 1) throw new Error(`No one bench line on ${date}`);
	await ctx.db.execute(
		sql`insert into set_prescriptions (planned_exercise_id, position, role, sets, reps_min,
				reps_max, target_rpe, load_kind, load_value, load_unit, rest_seconds)
			values (${rows[0]!.id}, 2, 'working', 3, 5, 5, 8, 'absolute', ${FIXED_BENCH_KG}, 'kg', 150)`
	);
	return rows[0]!.lineage;
}

/**
 * Seed `layout` as of `at` (a context whose today and now may be earlier than the real ones), add
 * the fixed bench lines to the week after the reviewed one, then store the review at `at`.
 */
async function reviewed(
	ctx: SeedContext,
	at: SeedContext,
	layout: Layout,
	week: number
): Promise<ReviewFixtureResult> {
	const seeded = (await weekly(layout, week)(at)) as ReviewFixtureResult;
	if (seeded.review.kind !== 'weekly') throw new Error('A weekly scenario');
	const { weekStartsOn, nextWeekStartsOn } = seeded.review;
	const benchMonday = await fixedBench(ctx, nextWeekStartsOn);
	const benchThursday = await fixedBench(ctx, addDays(nextWeekStartsOn, 3));
	const now = () => at.now;
	await createWeeklyReview(ctx.ownerId, { weekStartsOn, today: at.today }, { db: ctx.db, now });
	return { ...seeded, lineages: { ...seeded.lineages, benchMonday, benchThursday } };
}

/** On a Monday, log today's Strength A after the review: its change has started. */
async function startMonday(ctx: SeedContext, lineage: string) {
	const program = (await getCurrentProgram(ctx.ownerId, ctx.today, { db: ctx.db }))!;
	const version = await getProgramVersion(ctx.ownerId, program.id, program.version.number, {
		db: ctx.db
	});
	const weeks = version.blocks.flatMap((b) => b.weeks);
	const w = weeks.findIndex((week) => week.startsOn === ctx.weekStart);
	const session = weeks[w]!.sessions.find((s) => s.lineage === lineage)!;
	const found = await resolveKeys(KEYS, { db: ctx.db });
	const ids = Object.fromEntries(KEYS.map((k) => [k, found.get(k)!.id])) as Record<Key, string>;
	await logSession(ctx, ids, session, w, false);
}

export const fixtures = {
	'review-ahead': async (ctx) => reviewed(ctx, ctx, AHEAD, 0),
	'review-aged': async (ctx) => {
		// This week's Monday, early: before anything of this week, never after now.
		const monday = atLocal(ctx.weekStart, '06:00', ctx.timeZone);
		const now = new Date(Math.min(monday.getTime(), ctx.now.getTime() - 60_000));
		const at = { ...ctx, now, today: ctx.weekStart };
		const result = await reviewed(ctx, at, AGED, -1);
		if (ctx.today === ctx.weekStart) await startMonday(ctx, result.lineages.benchMonday!);
		return result;
	}
} satisfies Record<string, AnalyticsFixture>;
