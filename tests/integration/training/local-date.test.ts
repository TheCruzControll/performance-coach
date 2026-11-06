/**
 * The owner's today (src/lib/server/local-date.ts) on real Postgres: the calendar day in the time
 * zone stored on the profile, not the server's or UTC's, so it turns over at the owner's own
 * midnight, daylight saving included.
 */
import { describe, expect, it } from 'vitest';
import { ownerToday } from '../../../src/lib/server/local-date';
import { getAthleteProfile, saveBasics } from '../../../src/lib/server/services/profile';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';
import type { Executor } from '../../../src/lib/server/db';

async function ownerIn(db: Executor, timeZone: string): Promise<string> {
	const owner = await makeOwner(db);
	await saveBasics(owner, { name: 'Niko', weightUnit: 'kg', distanceUnit: 'km', timeZone }, { db });
	return owner;
}

const at = (instant: string) => new Date(instant);

describe('ownerToday', () => {
	it('turns over at midnight in London, in GMT and in BST', async () => {
		await withRollback(async (db) => {
			const owner = await ownerIn(db, 'Europe/London');
			// GMT (UTC+0) the day before the clocks go forward: still the 28th.
			expect(await ownerToday(owner, at('2026-03-28T23:30:00Z'), { db })).toBe('2026-03-28');
			// BST (UTC+1): 23:30 UTC is already 00:30 on 1 July.
			expect(await ownerToday(owner, at('2026-06-30T23:30:00Z'), { db })).toBe('2026-07-01');
			expect(await ownerToday(owner, at('2026-06-30T22:59:59Z'), { db })).toBe('2026-06-30');
		});
	});

	it('turns over at midnight in Auckland (NZDT, UTC+13), a day ahead of UTC', async () => {
		await withRollback(async (db) => {
			const owner = await ownerIn(db, 'Pacific/Auckland');
			expect(await ownerToday(owner, at('2026-11-05T10:59:00Z'), { db })).toBe('2026-11-05');
			expect(await ownerToday(owner, at('2026-11-05T11:00:00Z'), { db })).toBe('2026-11-06');
		});
	});

	it('is the UTC day for a profile whose zone was never set', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			expect((await getAthleteProfile(owner, { db })).timeZone).toBe('UTC');
			expect(await ownerToday(owner, at('2026-06-30T23:30:00Z'), { db })).toBe('2026-06-30');
			expect(await ownerToday(owner, at('2026-07-01T00:00:00Z'), { db })).toBe('2026-07-01');
		});
	});

	it('follows the zone the profile holds now', async () => {
		await withRollback(async (db) => {
			const owner = await ownerIn(db, 'Europe/London');
			const instant = at('2026-11-05T12:30:00Z');
			expect(await ownerToday(owner, instant, { db })).toBe('2026-11-05');
			await saveBasics(
				owner,
				{ name: 'Niko', weightUnit: 'kg', distanceUnit: 'km', timeZone: 'Pacific/Kiritimati' },
				{ db }
			);
			// UTC+14: 12:30 UTC is 02:30 the next morning.
			expect(await ownerToday(owner, instant, { db })).toBe('2026-11-06');
		});
	});
});
