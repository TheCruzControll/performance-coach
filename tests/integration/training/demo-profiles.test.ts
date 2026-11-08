/**
 * The demo profiles the seeded Lighthouse run plans from (scripts/lib/demo-profiles.ts), on real
 * Postgres. seedDemoProfile commits through its own pg connection, so each test runs inside
 * withCommitted, whose truncate removes the owner and every profile row afterwards; later files'
 * makeOwner then still succeeds under owners_singleton_uq. The profiles read back through the M2
 * service as complete, and the real generator previews a program from each.
 */
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_PROFILES, seedDemoProfile } from '../../../scripts/lib/demo-profiles';
import { getDb } from '../../../src/lib/server/db';
import { getTrainingProfile } from '../../../src/lib/server/services/profile';
import { previewProgram } from '../../../src/lib/server/services/programming/index';
import { withCommitted } from '../helpers';
import { makeOwner } from '../profile/fixtures';

/** A Thursday; 'next_monday' plans the week of 2026-11-09. */
const TODAY = '2026-11-05';

let client: pg.Client;
beforeEach(async () => {
	client = new pg.Client({ connectionString: process.env.DATABASE_URL });
	await client.connect();
});
afterEach(() => client.end());

/** Rows left in the tables a demo profile writes, and owners. */
async function leftover(): Promise<number> {
	const result = await getDb().execute<{ n: number }>(
		sql`select (select count(*) from owners) + (select count(*) from athlete_profiles)
		  + (select count(*) from training_goals) + (select count(*) from schedules)
		  + (select count(*) from strength_baselines) + (select count(*) from body_weight_entries)
		  as n`
	);
	return Number(result.rows[0]!.n);
}

describe('seedDemoProfile', () => {
	it('writes hybrid-blank: three ranked goals, no 1RMs, Muay Thai classes, onboarding complete', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			await seedDemoProfile(client, owner, 'hybrid-blank');
			const profile = await getTrainingProfile(owner, { db });
			expect(profile.profile.onboarding.completedAt).not.toBeNull();
			expect(profile.profile.baselinesUnknown).toBe(true);
			expect(profile.goals.map((g) => [g.priority, g.disciplines])).toEqual([
				[1, ['strength']],
				[2, ['running']],
				[3, ['muay_thai']]
			]);
			expect(profile.baselines).toEqual([]);
			expect(profile.equipment?.gymType).toBe('commercial');
			expect(profile.running?.runsPerWeek).toBe(3);
			expect(profile.schedule).toMatchObject({ daysPerWeek: 5, sessionMinutes: 60 });
			expect(profile.schedule.commitments).toMatchObject([
				{ discipline: 'muay_thai', days: ['tue', 'thu'], durationMinutes: 90, intensity: 'hard' }
			]);

			const preview = await previewProgram(owner, { today: TODAY, start: 'next_monday' }, { db });
			const sessions = preview.week.days.flatMap((d) => d.sessions);
			expect(new Set(sessions.map((s) => s.discipline))).toEqual(
				new Set(['strength', 'running', 'muay_thai'])
			);
			expect(preview.fingerprint).toMatch(/^[0-9a-f]{16}$/);
		});
		expect(await leftover()).toBe(0);
	});

	it('writes powerlifter-measured: tested squat, bench and deadlift that week 1 loads from', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			await seedDemoProfile(client, owner, 'powerlifter-measured');
			const profile = await getTrainingProfile(owner, { db });
			expect(profile.profile.onboarding.completedAt).not.toBeNull();
			expect(profile.profile.baselinesUnknown).toBe(false);
			expect(profile.goals.map((g) => g.disciplines)).toEqual([['powerlifting']]);
			expect(
				profile.baselines.map(({ lift, kind, value, unit }) => ({ lift, kind, value, unit }))
			).toEqual(
				expect.arrayContaining([
					{ lift: 'back_squat', kind: 'measured', value: 200, unit: 'kg' },
					{ lift: 'bench_press', kind: 'measured', value: 140, unit: 'kg' },
					{ lift: 'deadlift', kind: 'measured', value: 240, unit: 'kg' }
				])
			);

			const preview = await previewProgram(owner, { today: TODAY, start: 'next_monday' }, { db });
			const sessions = preview.week.days.flatMap((d) => d.sessions);
			expect(sessions.length).toBeGreaterThan(0);
			expect(sessions.every((s) => s.kind === 'strength')).toBe(true);
		});
		expect(await leftover()).toBe(0);
	});

	it('replaces the profile when run again, so a re-seed gives the same preview', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			await seedDemoProfile(client, owner, DEMO_PROFILES[0]);
			const first = await previewProgram(owner, { today: TODAY, start: 'next_monday' }, { db });
			await seedDemoProfile(client, owner, DEMO_PROFILES[1]);
			await seedDemoProfile(client, owner, DEMO_PROFILES[0]);
			const again = await previewProgram(owner, { today: TODAY, start: 'next_monday' }, { db });
			expect(again.fingerprint).toBe(first.fingerprint);
			expect((await getTrainingProfile(owner, { db })).goals).toHaveLength(3);
		});
		expect(await leftover()).toBe(0);
	});
});
