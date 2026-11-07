/**
 * Training histories for the M6 dashboard specs and their integration test, seeded through the
 * real services (M2's profile, M3's program store, edits and logging) at dates the server works
 * out from the owner's today, so a browser test never computes a date of its own.
 *
 * - FIXTURES collects the `fixtures` export of every other .ts file in this folder, so a later
 *   slice adds a fixture by adding a file and edits nothing here (review-test-support adds its
 *   review weeks that way). Two files naming the same fixture is an error at load.
 * - A seed starts from an owner with no program, workout or recovery note: Postgres keeps that
 *   history (ADR 0010) and server code never truncates it, so the test reset empties it first
 *   (e2e/analytics-support.ts resetAnalytics, or the integration test's own reset). A seed on top
 *   of training data is refused with AnalyticsSeedConflictError and writes nothing.
 * - The profile is written through M2's services, which supersede what they replace: the time
 *   zone the caller names, kg and km (so the specs read every number in one unit), and whatever
 *   else the fixture needs.
 *
 * TEST ONLY: used by /api/test-support/analytics (404 unless test routes are enabled) and by
 * tests/integration/analytics/test-fixtures.test.ts, never by app code.
 */
import { sql } from 'drizzle-orm';
import { mondayOf, type IsoDate } from '../../../domain/calendar';
import { getDb, type Executor } from '../../db';
import { ownerToday } from '../../local-date';
import { getAthleteProfile, saveBasics } from '../../services/profile/index';

/** What a fixture is handed: who, when, and the executor every service call runs on. */
export interface SeedContext {
	ownerId: string;
	timeZone: string;
	/** The instant the seed runs at: nothing is logged after it. */
	now: Date;
	/** The owner's today in `timeZone` (ownerToday), and the Monday of its week. */
	today: IsoDate;
	weekStart: IsoDate;
	db: Executor;
}

/** The ids a spec needs to find what a fixture stored, by the names the fixture gives them. */
export interface FixtureResult {
	programId: string | null;
	/** The Monday of the history's first week; null when nothing was logged or planned. */
	historyStart: IsoDate | null;
	/** Catalogue key → exercise id, for every exercise the fixture logs. */
	exercises: Record<string, string>;
	/** Workout row ids, e.g. abandoned, inProgress, deleted, offPlan. */
	workouts: Record<string, string>;
	/** Planned-session lineages, e.g. skipped, moved, missed. */
	lineages: Record<string, string>;
}

export interface SeededAnalytics extends FixtureResult {
	fixture: string;
	timeZone: string;
	today: IsoDate;
	weekStart: IsoDate;
}

export type AnalyticsFixture = (context: SeedContext) => Promise<FixtureResult>;

type FixtureModule = { fixtures?: Readonly<Record<string, AnalyticsFixture>> };

function collect(
	modules: Record<string, FixtureModule>
): Readonly<Record<string, AnalyticsFixture>> {
	const all: Record<string, AnalyticsFixture> = {};
	for (const [file, module] of Object.entries(modules)) {
		for (const [name, fixture] of Object.entries(module.fixtures ?? {})) {
			if (Object.hasOwn(all, name)) throw new Error(`Analytics fixture '${name}' twice (${file})`);
			all[name] = fixture;
		}
	}
	return all;
}

/** Every analytics fixture, by name. */
export const FIXTURES = collect(
	import.meta.glob<FixtureModule>(['./*.ts', '!./index.ts', '!./*.test.ts'], { eager: true })
);

export const isAnalyticsFixture = (name: unknown): name is string =>
	typeof name === 'string' && Object.hasOwn(FIXTURES, name);

/** The owner already has training data: reset before seeding. Nothing was written. */
export class AnalyticsSeedConflictError extends Error {
	constructor() {
		super('The owner already has a program, workouts or recovery notes: reset before seeding');
		this.name = 'AnalyticsSeedConflictError';
	}
}

async function holdsTrainingData(db: Executor, ownerId: string): Promise<boolean> {
	const { rows } = await db.execute<{ held: boolean }>(
		sql`select exists (select 1 from programs where owner_id = ${ownerId})
			or exists (select 1 from workouts where owner_id = ${ownerId})
			or exists (select 1 from recovery_notes where owner_id = ${ownerId}) as held`
	);
	return rows[0]!.held;
}

/**
 * Seed fixture `name` for `ownerId`: record `timeZone` on the profile, take today from it
 * (ownerToday at `now`), then run the fixture. RangeError for an unknown fixture name.
 */
export async function seedAnalyticsFixture(
	ownerId: string,
	name: string,
	options: { timeZone: string; now?: Date },
	deps: { db?: Executor } = {}
): Promise<SeededAnalytics> {
	if (!isAnalyticsFixture(name)) throw new RangeError(`No analytics fixture '${name}'`);
	const db = deps.db ?? getDb();
	const now = options.now ?? new Date();
	if (await holdsTrainingData(db, ownerId)) throw new AnalyticsSeedConflictError();
	const { name: owner } = await getAthleteProfile(ownerId, { db });
	const basics = {
		name: owner || 'Niko',
		weightUnit: 'kg',
		distanceUnit: 'km',
		timeZone: options.timeZone
	};
	await saveBasics(ownerId, basics, { db });
	const today = await ownerToday(ownerId, now, { db });
	const weekStart = mondayOf(today);
	const context = { ownerId, timeZone: options.timeZone, now, today, weekStart, db };
	const result = await FIXTURES[name]!(context);
	return { fixture: name, timeZone: options.timeZone, today, weekStart, ...result };
}
