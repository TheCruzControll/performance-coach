/**
 * The Strength view's weeks (domain/analytics/strength-weeks.ts), each closed week summed once and
 * kept in strength_week_rollups (schema/analytics.ts), the week in progress summed on each request.
 *
 * Reading (createStrengthWeeks, one per request):
 * - A closed week before last week comes from its rollup when that is current: written since the
 *   week last changed, for the profile's time zone and today's analytics and digest versions, and
 *   not split. Every other week (missing, stale, split, last week and this one) is summed from the
 *   facts, a run of consecutive weeks at a time, so a workout run past midnight on a Sunday stays
 *   one session there. A rollup is used only where the facts would give the same: a week it holds
 *   has no workout with a set or its start in another week.
 * - The facts are the facts loader's (facts.ts), read once per range: days already read are
 *   filtered, never read again, so a request reads each kind as the loader would.
 * - Nothing is written: a request only reads. The rollups' read is timed as 'analytics' in
 *   Server-Timing, as the facts are.
 *
 * Writing (refreshStrengthWeeks, after a sync batch applies to a completed or deleted workout, and
 * backfillStrengthWeeks, after every deploy's migrations in `pnpm db:migrate`):
 * - Every closed week from the first activity's whose rollup is missing, stale or for another time
 *   zone or version is summed from the facts and written, with the generation read before them, so
 *   a week a later write marks stale keeps its mark (queries/strength-weeks.ts). The deploy's run
 *   writes every week the existing data, the catalogue seed or a version bump left unwritten; a
 *   time-zone change rewrites them on the next sync. Until a week is written it is summed from the
 *   facts, as before the rollups.
 * - A week holding a workout with a set or its start in another week is written split, without a
 *   digest, so the reads sum it with its neighbours.
 * Every read and write is awaited in turn, so `db` may be a transaction.
 */
import { ANALYTICS_VERSION } from '../../../domain/analytics/version';
import {
	DIGEST_VERSION,
	packWeek,
	strengthWeeks,
	unpackWeek,
	type StrengthWeek,
	type WeekParts,
	type WeekPlan
} from '../../../domain/analytics/strength-weeks';
import { addDays, mondayOf, type IsoDate } from '../../../domain/calendar';
import { localDay } from '../../../domain/dates';
import type { WeightUnit } from '../../../domain/units';
import {
	createAnalyticsRepository,
	type AnalyticsRepository,
	type SetFact
} from '../../db/repositories/analytics';
import {
	createStrengthWeeksRepository,
	type StrengthWeekRow,
	type StrengthWeekWrite
} from '../../db/repositories/strength-weeks';
import { createAuthRepository } from '../../db/repositories/auth';
import type { Executor } from '../../db/types';
import { measure } from '../../observability/timing';
import { getExercisesByIds, type ExerciseDef } from '../exercises/index';
import { getAthleteProfile } from '../profile/index';
import { createFactsLoader } from './facts';

export interface StrengthWeeksDeps {
	/** The fact reads, for a test to count; the analytics repository on `db` unless given. */
	repository?: AnalyticsRepository;
}

/**
 * The parts of the weeks a reader needs (WeekParts): the overview's headline, the Strength view's
 * figures, the records its PRs fold, or all of them. A rollup holds them all.
 */
export const WEEKS_USES = {
	headline: { figures: true, detail: false, records: false },
	figures: { figures: true, detail: true, records: false },
	records: { figures: false, detail: false, records: true },
	all: { figures: true, detail: true, records: true }
} as const satisfies Record<string, Omit<WeekParts, 'plan'>>;
export type WeeksUse = keyof typeof WEEKS_USES;

export interface StrengthWeeksSource {
	/** Each week from `from`'s Monday to `today`'s, oldest first, summed over `from` to `today`. */
	weeks(from: IsoDate, today: IsoDate, use: WeeksUse): Promise<StrengthWeek[]>;
	/** The counted sets of `from` to `to`, by the time they were performed. */
	sets(from: IsoDate, to: IsoDate): Promise<SetFact[]>;
	/** The exercises these ids name, each read once per request. */
	exercises(ids: Iterable<string>): Promise<ReadonlyMap<string, ExerciseDef>>;
}

/** Each Monday from `from` to `to`, both Mondays. */
function mondaysOf(from: IsoDate, to: IsoDate): IsoDate[] {
	const mondays: IsoDate[] = [];
	for (let monday = from; monday <= to; monday = addDays(monday, 7)) mondays.push(monday);
	return mondays;
}

/** Whether a row was written for this time zone and today's versions (split or not). */
const written = (row: StrengthWeekRow | undefined, timeZone: string): row is StrengthWeekRow =>
	row !== undefined &&
	row.writtenAt !== null &&
	row.timeZone === timeZone &&
	row.analyticsVersion === ANALYTICS_VERSION &&
	row.digestVersion === DIGEST_VERSION;

export function createStrengthWeeks(
	db: Executor,
	ownerId: string,
	{ timeZone, weightUnit }: { timeZone: string; weightUnit: WeightUnit },
	{ repository = createAnalyticsRepository(db) }: StrengthWeeksDeps = {}
): StrengthWeeksSource {
	const rollups = createStrengthWeeksRepository(db);
	const loader = (from: IsoDate, to: IsoDate) =>
		createFactsLoader(db, ownerId, { from, to, timeZone }, { repository });

	/** The days read, consecutive ranges kept apart, oldest first. */
	const parts: { from: IsoDate; to: IsoDate; sets: SetFact[] }[] = [];
	async function sets(from: IsoDate, to: IsoDate): Promise<SetFact[]> {
		const gaps: [IsoDate, IsoDate][] = [];
		let day = from;
		for (const part of parts) {
			if (day > to) break;
			if (part.to < day) continue;
			if (part.from > day) gaps.push([day, part.from <= to ? addDays(part.from, -1) : to]);
			day = addDays(part.to, 1);
		}
		if (day <= to) gaps.push([day, to]);
		for (const [a, b] of gaps) parts.push({ from: a, to: b, sets: await loader(a, b).sets() });
		parts.sort((a, b) => (a.from < b.from ? -1 : 1));
		const kept: SetFact[] = [];
		for (const part of parts) {
			if (part.to < from || part.from > to) continue;
			const whole = from <= part.from && part.to <= to;
			for (const set of part.sets) {
				if (whole) kept.push(set);
				else {
					const on = localDay(set.performedAt, timeZone);
					if (from <= on && on <= to) kept.push(set);
				}
			}
		}
		return kept;
	}

	const plans = new Map<string, Promise<Omit<WeekPlan, 'unit'>>>();
	function planOf(from: IsoDate, to: IsoDate) {
		const key = `${from}/${to}`;
		if (!plans.has(key)) {
			const facts = loader(from, to);
			plans.set(
				key,
				(async () => ({
					workouts: await facts.sessions(),
					prescriptions: await facts.prescriptions()
				}))()
			);
		}
		return plans.get(key)!;
	}

	const known = new Map<string, ExerciseDef>();
	async function exercises(ids: Iterable<string>) {
		const missing = [...new Set(ids)].filter((id) => !known.has(id));
		if (missing.length)
			for (const [id, def] of await getExercisesByIds(ownerId, missing, { db })) known.set(id, def);
		return known;
	}

	/** Consecutive weeks summed from the facts of their days within `from` to `today`. */
	async function sum(mondays: IsoDate[], from: IsoDate, today: IsoDate, use: WeeksUse) {
		const first = mondays[0]! < from ? from : mondays[0]!;
		const sunday = addDays(mondays.at(-1)!, 6);
		const last = sunday < today ? sunday : today;
		const facts = await sets(first, last);
		const parts = WEEKS_USES[use];
		const plan = parts.detail ? { ...(await planOf(first, last)), unit: weightUnit } : null;
		const lifts = await exercises(facts.map((set) => set.exercise));
		return strengthWeeks(facts, lifts, timeZone, mondays, { ...parts, plan });
	}

	const memo = new Map<string, Promise<StrengthWeek[]>>();
	async function weeksOf(from: IsoDate, today: IsoDate, use: WeeksUse) {
		const withExposures = WEEKS_USES[use].detail;
		const thisMonday = mondayOf(today);
		const start = mondayOf(from);
		// Closed weeks before last week; last week's days are read anyway, for 'so far'.
		const lastRolled = addDays(thisMonday, -14);
		const rolled = new Map<IsoDate, StrengthWeek>();
		if (start <= lastRolled) {
			const stored = await measure('analytics', () => rollups.rows(ownerId, start, lastRolled));
			for (const row of stored) {
				if (!written(row, timeZone) || !row.digest) continue;
				const digest = unpackWeek(row.weekStart, row.digest);
				// A week begun before `from` only when it has no set before it, and without exposures.
				if (row.weekStart < from && (withExposures || (digest.firstDay ?? from) < from)) continue;
				rolled.set(row.weekStart, digest);
			}
		}
		const weeks: StrengthWeek[] = [];
		let run: IsoDate[] = [];
		for (const monday of mondaysOf(start, thisMonday)) {
			const digest = rolled.get(monday);
			if (!digest) {
				run.push(monday);
				continue;
			}
			if (run.length) weeks.push(...(await sum(run, from, today, use)));
			run = [];
			weeks.push(digest);
		}
		if (run.length) weeks.push(...(await sum(run, from, today, use)));
		return weeks;
	}

	return {
		weeks(from, today, use) {
			const key = `${from}/${today}/${use}`;
			if (!memo.has(key)) memo.set(key, weeksOf(from, today, use));
			return memo.get(key)!;
		},
		sets,
		exercises
	};
}

/**
 * Write every closed week whose rollup is missing or not current (written), from the first
 * activity's week to last week, on the owner's calendar at `now`. Returns how many were written:
 * a week marked stale while it was summed is not.
 */
export async function refreshStrengthWeeks(
	db: Executor,
	ownerId: string,
	now: Date,
	{ repository = createAnalyticsRepository(db) }: StrengthWeeksDeps = {}
): Promise<number> {
	const rollups = createStrengthWeeksRepository(db);
	const { timeZone, weightUnit } = await getAthleteProfile(ownerId, { db });
	const at = await repository.firstActivity(ownerId);
	if (!at) return 0;
	const start = mondayOf(localDay(at, timeZone));
	const lastClosed = addDays(mondayOf(localDay(now, timeZone)), -7);
	if (start > lastClosed) return 0;
	const rows = new Map(
		(await rollups.rows(ownerId, start, lastClosed)).map((row) => [row.weekStart, row])
	);
	const stale = mondaysOf(start, lastClosed).filter(
		(monday) => !written(rows.get(monday), timeZone)
	);
	const runs: IsoDate[][] = [];
	for (const monday of stale) {
		const run = runs.at(-1);
		if (run && addDays(run.at(-1)!, 7) === monday) run.push(monday);
		else runs.push([monday]);
	}

	const writes: StrengthWeekWrite[] = [];
	const weekOf = (instant: Date) => mondayOf(localDay(instant, timeZone));
	for (const run of runs) {
		const facts = createFactsLoader(
			db,
			ownerId,
			{ from: run[0]!, to: addDays(run.at(-1)!, 6), timeZone },
			{ repository }
		);
		const sets = await facts.sets();
		const workouts = await facts.sessions();
		const prescriptions = await facts.prescriptions();
		const ids = [...new Set(sets.map((set) => set.exercise))];
		const lifts = await getExercisesByIds(ownerId, ids, { db });
		const plan = { workouts, prescriptions, unit: weightUnit };
		const digests = strengthWeeks(sets, lifts, timeZone, run, { plan });

		// The workouts each week holds: those with a set in it, and the strength ones started in it.
		const held = new Map<IsoDate, Set<string>>();
		const hold = (monday: IsoDate, id: string) =>
			held.set(monday, (held.get(monday) ?? new Set()).add(id));
		for (const set of sets) hold(weekOf(set.performedAt), set.workoutId);
		for (const w of workouts) if (w.kind === 'strength') hold(mondayOf(w.date), w.id);
		const spans = await rollups.spans(ownerId, [
			...new Set([...held.values()].flatMap((s) => [...s]))
		]);
		const weeksOfWorkout = new Map(
			spans.map((span) => [
				span.id,
				new Set(
					[span.startedAt, span.firstSet, span.lastSet].flatMap((at) => (at ? [weekOf(at)] : []))
				)
			])
		);
		for (const [i, monday] of run.entries()) {
			const whole = [...(held.get(monday) ?? [])].every((id) => {
				const weeks = weeksOfWorkout.get(id);
				return weeks !== undefined && weeks.size === 1 && weeks.has(monday);
			});
			writes.push({
				ownerId,
				weekStart: monday,
				generation: rows.get(monday)?.generation ?? 0,
				writtenAt: now,
				timeZone,
				analyticsVersion: ANALYTICS_VERSION,
				digestVersion: DIGEST_VERSION,
				split: !whole,
				digest: whole ? packWeek(digests[i]!) : null
			});
		}
	}
	return rollups.write(writes);
}

/**
 * The deploy's backfill (scripts/lib/strength-weeks-backfill.ts, run by `pnpm db:migrate` after the
 * migrations): the owner's closed weeks written as a sync writes them, so Progress reads them from
 * the rollups before the first sync. How many were written; 0 before setup.
 */
export async function backfillStrengthWeeks(db: Executor, now: Date): Promise<number> {
	const owner = await createAuthRepository(db).getOwner();
	return owner ? refreshStrengthWeeks(db, owner.id, now) : 0;
}
