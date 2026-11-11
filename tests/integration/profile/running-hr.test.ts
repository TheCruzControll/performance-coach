/**
 * Heart rate on the running profile (the M7 plan's running-hr-db), on real Postgres through M2's
 * specifics service:
 * - max, resting and threshold heart rate round-trip, together or one at a time; a save that
 *   leaves heart rate out keeps what is stored, and `null` clears it.
 * - Each range CHECK refuses by name, and so does running_profiles_hr_order_ck when resting,
 *   threshold and max do not rise. The service reports the same mistakes at their fields first.
 * - A profile without heart rate reads with no heartRate key, as does a row written before the
 *   migration, which the migration leaves valid.
 * - Onboarding's specifics step saves heart rate through its step action, as an onboarding change.
 */
import { readFileSync } from 'node:fs';
import { eq, sql } from 'drizzle-orm';
import { isRedirect } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import { HEART_RATE_BOUNDS } from '../../../src/lib/domain/profile/catalog';
import { runningProfiles, type Executor } from '../../../src/lib/server/db';
import { stepActions, type SaveSection } from '../../../src/lib/server/forms/profile';
import { createGoal, getSpecifics, saveSpecifics } from '../../../src/lib/server/services/profile';
import { withRollback } from '../helpers';
import { eventGoal, fieldErrors, makeOwner } from './fixtures';

const running = (heartRate?: unknown) => ({
	unit: 'km',
	weeklyDistance: 40,
	races: [],
	...(heartRate === undefined ? {} : { heartRate })
});

/** The heart-rate columns as Postgres holds them. */
async function storedHr(db: Executor, owner: string) {
	const [row] = await db
		.select({
			max: runningProfiles.maxHr,
			resting: runningProfiles.restingHr,
			threshold: runningProfiles.thresholdHr
		})
		.from(runningProfiles)
		.where(eq(runningProfiles.ownerId, owner));
	return row ?? null;
}

type PgError = { code?: string; constraint?: string };
const UNDO = Symbol('undo');

/** Write heart rates straight into the table in an undone savepoint: the refusal, or null. */
async function rawWrite(db: Executor, owner: string, hr: Record<string, number | null>) {
	try {
		await db.transaction(async (tx) => {
			await tx.insert(runningProfiles).values({ ownerId: owner, unit: 'km', ...hr });
			throw UNDO;
		});
	} catch (err) {
		if (err === UNDO) return null;
		const { code, constraint } = ((err as { cause?: PgError }).cause ?? err) as PgError;
		return { code, constraint };
	}
	throw new Error('unreachable');
}

describe('heart rate on the running profile', () => {
	it('round-trips all three, then one at a time, through the specifics service', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const all = { max: 192, resting: 48, threshold: 172 };
			const saved = await saveSpecifics(owner, { running: running(all), muayThai: null }, { db });
			expect(saved.running?.heartRate).toEqual(all);
			expect(await getSpecifics(owner, { db })).toEqual(saved);
			expect(await storedHr(db, owner)).toEqual(all);

			// Partial: only resting known; the others are stored as null.
			const partial = await saveSpecifics(
				owner,
				{ running: running({ resting: 52 }), muayThai: null },
				{ db }
			);
			expect(partial.running?.heartRate).toEqual({ max: null, resting: 52, threshold: null });
			expect(await storedHr(db, owner)).toEqual({ max: null, resting: 52, threshold: null });
		});
	});

	it('keeps stored heart rates when a save leaves them out, and clears them on null', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const hr = { max: 188, resting: null, threshold: 168 };
			await saveSpecifics(owner, { running: running(hr), muayThai: null }, { db });

			// An editor without the fields (today's Profile and onboarding) saves the rest.
			const kept = await saveSpecifics(
				owner,
				{ running: { ...running(), weeklyDistance: 55 }, muayThai: null },
				{ db }
			);
			expect(kept.running).toMatchObject({ weeklyDistance: 55, heartRate: hr });

			const cleared = await saveSpecifics(
				owner,
				{ running: running(null), muayThai: null },
				{ db }
			);
			expect(cleared.running).not.toHaveProperty('heartRate');
			expect(await storedHr(db, owner)).toEqual({ max: null, resting: null, threshold: null });
		});
	});

	it('reads a profile with no heart rate with no heartRate key at all', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const saved = await saveSpecifics(owner, { running: running(), muayThai: null }, { db });
			expect(saved.running).not.toBeNull();
			expect(Object.keys(saved.running!)).not.toContain('heartRate');
			expect(Object.keys((await getSpecifics(owner, { db })).running!)).not.toContain('heartRate');
		});
	});

	it('reports out-of-range and out-of-order heart rates at their fields, and saves nothing', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			expect(
				await fieldErrors(
					saveSpecifics(
						owner,
						{
							running: running({ max: 250, resting: 20.5, threshold: 90 }),
							muayThai: null
						},
						{ db }
					)
				)
			).toEqual({
				'running.heartRate.max': 'Max heart rate between 120 and 230',
				'running.heartRate.resting': 'Resting heart rate between 30 and 110',
				'running.heartRate.threshold': 'Threshold heart rate between 100 and 225'
			});

			expect(
				await fieldErrors(
					saveSpecifics(
						owner,
						{ running: running({ max: 150, resting: 105, threshold: 160 }), muayThai: null },
						{ db }
					)
				)
			).toEqual({ 'running.heartRate.threshold': 'Threshold heart rate must be below your max' });

			expect(
				await fieldErrors(
					saveSpecifics(
						owner,
						{ running: running({ resting: 105, threshold: 105 }), muayThai: null },
						{ db }
					)
				)
			).toEqual({
				'running.heartRate.resting': 'Resting heart rate must be below your threshold'
			});
			expect(await storedHr(db, owner)).toBeNull();
		});
	});
});

describe('running_profiles heart-rate CHECKs', () => {
	const ck = (constraint: string) => ({ code: '23514', constraint });

	it('accepts each range’s ends and refuses one past them, by name', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const columns = { max: 'maxHr', resting: 'restingHr', threshold: 'thresholdHr' } as const;
			for (const kind of ['max', 'resting', 'threshold'] as const) {
				const { min, max } = HEART_RATE_BOUNDS[kind];
				const column = columns[kind];
				const name = `running_profiles_${kind}_hr_ck`;
				expect(await rawWrite(db, owner, { [column]: min }), `${kind} ${min}`).toBeNull();
				expect(await rawWrite(db, owner, { [column]: max }), `${kind} ${max}`).toBeNull();
				expect(await rawWrite(db, owner, { [column]: min - 1 })).toEqual(ck(name));
				expect(await rawWrite(db, owner, { [column]: max + 1 })).toEqual(ck(name));
			}
		});
	});

	it('refuses resting, threshold and max that do not rise, wherever two are given', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const order = ck('running_profiles_hr_order_ck');
			expect(await rawWrite(db, owner, { restingHr: 60, thresholdHr: 160, maxHr: 190 })).toBeNull();
			expect(await rawWrite(db, owner, { restingHr: 105, thresholdHr: 105 })).toEqual(order);
			expect(await rawWrite(db, owner, { thresholdHr: 190, maxHr: 190 })).toEqual(order);
			expect(await rawWrite(db, owner, { restingHr: 110, maxHr: 120 })).toBeNull();
			expect(await rawWrite(db, owner, { thresholdHr: 200, maxHr: 180 })).toEqual(order);
			// One value alone has nothing to rise against.
			expect(await rawWrite(db, owner, { restingHr: 110 })).toBeNull();
			expect(await rawWrite(db, owner, { thresholdHr: 225 })).toBeNull();
		});
	});
});

describe('the migration', () => {
	it('leaves a running profile written before it valid, reading with no heart rate', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			// Back to the table as it was before 0031 (dropping a column drops its CHECKs).
			await db.execute(
				sql`alter table running_profiles drop column max_hr, drop column resting_hr, drop column threshold_hr`
			);
			await db.execute(
				sql`insert into running_profiles (owner_id, unit, weekly_distance, easy_pace_seconds)
					values (${owner}, 'mi', 25, 540)`
			);
			const migration = readFileSync(
				new URL('../../../drizzle/0031_running_heart_rate.sql', import.meta.url),
				'utf8'
			);
			for (const statement of migration.split('--> statement-breakpoint')) {
				await db.execute(sql.raw(statement));
			}
			const { running } = await getSpecifics(owner, { db });
			expect(running).toMatchObject({ unit: 'mi', weeklyDistance: 25, easyPaceSeconds: 540 });
			expect(running).not.toHaveProperty('heartRate');
			expect(await storedHr(db, owner)).toEqual({ max: null, resting: null, threshold: null });
		});
	});
});

describe('onboarding’s specifics step', () => {
	it('saves heart rate through the step action, as an onboarding change', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await createGoal(
				owner,
				eventGoal({
					title: 'Spring marathon',
					disciplines: ['distance_running'],
					eventType: 'Marathon',
					weightClass: null
				}),
				{ db, source: 'onboarding' }
			);
			const sources: unknown[] = [];
			const save: SaveSection = (o, payload, deps) => {
				sources.push(deps?.source);
				return saveSpecifics(o, payload, { ...deps, db });
			};
			const body = new FormData();
			body.set(
				'payload',
				JSON.stringify({
					running: running({ max: 186, resting: 50, threshold: null }),
					muayThai: null
				})
			);
			const request = new Request('http://localhost/onboarding/specifics?/save', {
				method: 'POST',
				body
			});
			const locals: App.Locals = {
				requestId: 'test',
				session: {
					id: crypto.randomUUID(),
					ownerId: owner,
					ownerName: 'Niko',
					kind: 'owner',
					expiresAt: new Date(),
					reauthenticatedAt: null
				}
			};
			const outcome = await stepActions('specifics', save, (s) => `/onboarding/${s}`, {
				db
			})
				.save({ locals, request })
				.then(
					(value) => value,
					(err: unknown) => err
				);
			// Continue moved on to the next step, so the save went through.
			expect(isRedirect(outcome), JSON.stringify(outcome)).toBe(true);
			expect(sources).toEqual(['onboarding']);

			const rows = await db.execute<{ max_hr: number; resting_hr: number; threshold_hr: null }>(
				sql`select max_hr, resting_hr, threshold_hr from running_profiles where owner_id = ${owner}`
			);
			expect(rows.rows).toEqual([{ max_hr: 186, resting_hr: 50, threshold_hr: null }]);
		});
	});
});
