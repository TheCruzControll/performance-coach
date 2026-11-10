import { sql } from 'drizzle-orm';
import { createAuthRepository, type Executor } from '../../../src/lib/server/db';
import type { ProfileInputError } from '../../../src/lib/server/services/profile';

/** Create the owner directly (auth itself is covered by tests/integration/auth). */
export async function makeOwner(db: Executor, displayName = 'Niko Cruz'): Promise<string> {
	const owner = await createAuthRepository(db).insertOwner({
		displayName,
		webauthnUserId: `user-${crypto.randomUUID()}`
	});
	return owner.id;
}

/**
 * Another owner, inside the test's transaction only: the app allows one (owners_singleton_uq), so
 * this lifts that rule, and Postgres rolls the DDL back with the test. Call it once per test.
 */
export async function makeSecondOwner(db: Executor, displayName = 'Someone else'): Promise<string> {
	await db.execute(sql`drop index owners_singleton_uq`);
	await db.execute(sql`alter table owners drop constraint owners_singleton_ck`);
	return makeOwner(db, displayName);
}

/** A controllable clock. */
export function clock(start = '2026-11-05T09:00:00Z') {
	let t = new Date(start).getTime();
	return {
		now: () => new Date(t),
		advanceDays: (days: number) => {
			t += days * 86_400_000;
		}
	};
}

/** The field errors of a rejected save (fails the test if it did not reject that way). */
export async function fieldErrors(promise: Promise<unknown>): Promise<Record<string, string>> {
	const error = await promise.then(
		() => null,
		(err: unknown) => err
	);
	if (!error || (error as Error).name !== 'ProfileInputError') {
		throw new Error(`expected a ProfileInputError, got ${String(error)}`);
	}
	return (error as ProfileInputError).errors;
}

export const eventGoal = (overrides: Record<string, unknown> = {}) => ({
	kind: 'event',
	title: 'First Muay Thai fight',
	disciplines: ['muay_thai'],
	eventType: 'Muay Thai fight',
	eventDate: '2027-03-14',
	weightClass: '-71 kg',
	targetPerformance: 'Win, stay composed for 3 rounds',
	requirements: 'Make weight the day before',
	...overrides
});

export const generalGoal = (overrides: Record<string, unknown> = {}) => ({
	kind: 'general',
	title: 'Keep my strength',
	disciplines: ['strength'],
	focus: 'Hold squat and deadlift while fight camp runs',
	measure: 'Top sets at RPE 8 stay within 5%',
	...overrides
});
