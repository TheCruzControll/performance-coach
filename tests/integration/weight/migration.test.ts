/**
 * The migrations that make a day's weigh-in a single row: 0035 keeps each day's latest duplicate
 * (created_at, then id, as saveBody did) and 0036 adds the unique index. Run on a database that
 * is at 0034 and holds duplicates, so the migration itself is what is tested.
 */
import { rm } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { connectionConfig } from '../../../src/lib/server/db/connection';
import {
	journalMigrations,
	LOCAL_DATABASE_URLS,
	migrationsFolderUpTo,
	resetDatabase,
	runMigrations
} from '../../../src/lib/server/db/migrate';

const url = process.env.TEST_DATABASE_URL || LOCAL_DATABASE_URLS.test;
const BEFORE = '0034_replan_superseded_reasons';

/** This file migrates the shared test database back in time; the files after it get it whole. */
afterAll(async () => {
	await resetDatabase(url);
});

describe('weigh-in migrations (0035 and 0036)', () => {
	it('keep each day’s latest weigh-in and refuse a second one for the same day', async () => {
		const tags = (await journalMigrations()).map((m) => m.tag);
		const folder = await migrationsFolderUpTo(tags.indexOf(BEFORE) + 1);
		const client = new pg.Client(connectionConfig(url));
		await client.connect();
		try {
			await client.query('drop schema if exists drizzle cascade');
			await client.query('drop schema if exists public cascade');
			await client.query('create schema public');
			await runMigrations(url, { migrationsFolder: folder, seed: false });
			expect((await journalMigrations(folder)).at(-1)?.tag).toBe(BEFORE);

			// Two owners (the singleton rule lifted, as the test fixtures do, for this file only).
			await client.query('drop index owners_singleton_uq');
			await client.query('alter table owners drop constraint owners_singleton_ck');
			const owners = await client.query<{ id: string }>(
				`insert into owners (display_name, webauthn_user_id)
				 values ('Niko', 'user-a'), ('Someone else', 'user-b') returning id`
			);
			const [a, b] = owners.rows.map((r) => r.id);

			const weigh = (owner: string, day: string, value: number, createdAt: string) =>
				client.query<{ id: number }>(
					`insert into body_weight_entries (owner_id, value, unit, measured_on, source, created_at)
					 values ($1, $2, 'kg', $3, 'profile', $4) returning id::int as id`,
					[owner, value, day, createdAt]
				);
			const id = async (promise: ReturnType<typeof weigh>) => (await promise).rows[0]!.id;

			// Day 1: the later created_at survives.
			await weigh(a!, '2026-11-01', 74.6, '2026-11-01T08:00:00Z');
			const latestOfDay1 = await id(weigh(a!, '2026-11-01', 74.4, '2026-11-01T09:00:00Z'));
			// Day 2: the same created_at, so the higher id survives.
			await weigh(a!, '2026-11-02', 73.9, '2026-11-02T08:00:00Z');
			const laterIdOfDay2 = await id(weigh(a!, '2026-11-02', 73.5, '2026-11-02T08:00:00Z'));
			// Day 3: entered first but created last, so the later created_at survives, not the later id.
			const createdLastOfDay3 = await id(weigh(a!, '2026-11-03', 72, '2026-11-03T12:00:00Z'));
			const enteredLastOfDay3 = await id(weigh(a!, '2026-11-03', 72.4, '2026-11-03T08:00:00Z'));
			expect(enteredLastOfDay3).toBeGreaterThan(createdLastOfDay3);
			// Another owner's weigh-in on the same day is not a duplicate of these.
			const otherOwner = await id(weigh(b!, '2026-11-01', 80, '2026-11-01T08:00:00Z'));

			await runMigrations(url, { seed: false });

			const kept = await client.query<{ id: number; owner_id: string; measured_on: string }>(
				`select id::int as id, owner_id, measured_on::text as measured_on
				 from body_weight_entries order by id`
			);
			expect(kept.rows).toEqual([
				{ id: latestOfDay1, owner_id: a, measured_on: '2026-11-01' },
				{ id: laterIdOfDay2, owner_id: a, measured_on: '2026-11-02' },
				{ id: createdLastOfDay3, owner_id: a, measured_on: '2026-11-03' },
				{ id: otherOwner, owner_id: b, measured_on: '2026-11-01' }
			]);

			// The unique index: a second weigh-in for a day the owner already has is refused.
			const second = await client
				.query(
					`insert into body_weight_entries (owner_id, value, unit, measured_on, source)
					 values ($1, 70, 'kg', '2026-11-01', 'profile')`,
					[a]
				)
				.then(
					() => null,
					(err: { code?: string; constraint?: string }) => err
				);
			expect(second).toMatchObject({
				code: '23505',
				constraint: 'body_weight_entries_owner_day_uq'
			});
			// A new day, and the same day for another owner, are both fine.
			await client.query(
				`insert into body_weight_entries (owner_id, value, unit, measured_on, source)
				 values ($1, 70, 'kg', '2026-11-04', 'profile')`,
				[a]
			);
		} finally {
			await client.end();
			await rm(folder, { recursive: true, force: true });
		}
	});
});
