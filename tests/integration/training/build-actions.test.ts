/**
 * Today's Build actions (src/lib/server/forms/build.ts) on real Postgres, through the real
 * programming services, with a fixed clock: the device's time zone travels with ?/preview and
 * ?/build, so both count today in it and agree; the previewed fingerprint and dates come back
 * with the build, which stores version 1 or refuses with the conflict's reason and writes
 * nothing; the build records the zone on the profile; and nobody without the owner's session
 * reaches either.
 */
import { isActionFailure, isHttpError } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { CATALOGUE } from '../../../src/lib/domain/exercises/index';
import type { Executor } from '../../../src/lib/server/db';
import {
	buildActions,
	type BuildDeps,
	type PreviewResult
} from '../../../src/lib/server/forms/build';
import {
	completeOnboarding,
	createGoal,
	getAthleteProfile,
	saveBasics,
	saveSchedule
} from '../../../src/lib/server/services/profile';
import { getProgramVersion } from '../../../src/lib/server/services/programs/index';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

/** Thursday 5 November in UTC; already Friday 6 November in Auckland (UTC+13). */
const INSTANT = '2026-11-05T11:30:00Z';
const AUCKLAND = 'Pacific/Auckland';
const at =
	(iso = INSTANT) =>
	() =>
		new Date(iso);

const schedule = (sessionMinutes: number | null = null) => ({
	daysPerWeek: 3,
	availableDays: [],
	preferredTimes: [],
	sessionMinutes,
	constraints: null,
	commitments: []
});

/** What a completed onboarding needs and nothing more, with the profile in `timeZone`. */
async function readyOwner(db: Executor, timeZone = 'UTC'): Promise<string> {
	const owner = await makeOwner(db);
	await createGoal(
		owner,
		{
			kind: 'general',
			title: 'Get stronger',
			disciplines: ['strength'],
			focus: 'Get stronger',
			measure: 'Train every planned week'
		},
		{ db }
	);
	await saveSchedule(owner, schedule(), { db });
	await completeOnboarding(owner, { db });
	if (timeZone !== 'UTC') {
		await saveBasics(
			owner,
			{ name: 'Niko', weightUnit: 'kg', distanceUnit: 'km', timeZone },
			{ db }
		);
	}
	return owner;
}

function locals(ownerId: string | null): App.Locals {
	if (!ownerId) return { requestId: 'test' } as App.Locals;
	return {
		requestId: 'test',
		session: {
			id: crypto.randomUUID(),
			ownerId,
			ownerName: 'Niko',
			kind: 'owner',
			expiresAt: new Date(),
			reauthenticatedAt: null
		}
	};
}

/** The request the Build screen sends: its state as JSON in `payload`. */
function post(action: string, payload: unknown): Request {
	const body = new FormData();
	body.set('payload', JSON.stringify(payload));
	return new Request(`http://localhost/today?/${action}`, { method: 'POST', body });
}

async function preview(owner: string, payload: unknown, deps: BuildDeps): Promise<PreviewResult> {
	const result = await buildActions(deps).preview({
		locals: locals(owner),
		request: post('preview', payload)
	});
	if (isActionFailure(result)) throw new Error(`preview refused: ${JSON.stringify(result)}`);
	return result as PreviewResult;
}

const build = (owner: string, payload: unknown, deps: BuildDeps) =>
	buildActions(deps).build({ locals: locals(owner), request: post('build', payload) });

/** What Start week 1 sends back: the zone and the preview's dates and fingerprints. */
const confirm = ({ preview: p }: PreviewResult, start: string, timeZone?: string) => ({
	timeZone,
	start,
	startsOn: p.startsOn,
	firstPlannedDay: p.firstPlannedDay,
	fingerprint: p.fingerprint,
	digest: p.digest
});

async function programs(db: Executor): Promise<number> {
	const { rows } = await db.execute<{ n: number }>(sql`select count(*)::int as n from programs`);
	return rows[0]!.n;
}

describe('the Build actions count today in the device’s time zone', () => {
	it('previews from Friday in Auckland while it is still Thursday in UTC', async () => {
		await withRollback(async (db) => {
			const owner = await readyOwner(db);
			const deps = { db, now: at() };
			const auckland = await preview(owner, { timeZone: AUCKLAND, start: 'this_week' }, deps);
			expect(auckland.today).toBe('2026-11-06');
			expect([auckland.preview.startsOn, auckland.preview.firstPlannedDay]).toEqual([
				'2026-11-02',
				'2026-11-06'
			]);
			expect(auckland.starts).toEqual({
				next_monday: { startsOn: '2026-11-09', firstPlannedDay: '2026-11-09' },
				this_week: { startsOn: '2026-11-02', firstPlannedDay: '2026-11-06' }
			});
			const utc = await preview(owner, { timeZone: 'UTC', start: 'this_week' }, deps);
			expect([utc.today, utc.preview.firstPlannedDay]).toEqual(['2026-11-05', '2026-11-05']);
			// With no start asked for, the default: next Monday, whole.
			const plain = await preview(owner, { timeZone: AUCKLAND }, deps);
			expect(plain.start).toBe('next_monday');
			expect([plain.preview.startsOn, plain.preview.firstPlannedDay]).toEqual([
				'2026-11-09',
				'2026-11-09'
			]);
		});
	});

	it('falls back to the profile’s zone for an invalid or a missing zone', async () => {
		await withRollback(async (db) => {
			const owner = await readyOwner(db, AUCKLAND);
			const deps = { db, now: at() };
			for (const payload of [{ timeZone: 'Mars/Base' }, { timeZone: 42 }, {}]) {
				const result = await preview(owner, { ...payload, start: 'this_week' }, deps);
				expect([result.today, result.preview.firstPlannedDay], JSON.stringify(payload)).toEqual([
					'2026-11-06',
					'2026-11-06'
				]);
			}
		});
	});
});

describe('Start week 1', () => {
	it('builds what was previewed: its fingerprint, startsOn and firstPlannedDay round-trip', async () => {
		await withRollback(async (db) => {
			const owner = await readyOwner(db);
			const deps = { db, now: at() };
			const shown = await preview(owner, { timeZone: AUCKLAND, start: 'this_week' }, deps);
			const built = await build(owner, confirm(shown, 'this_week', AUCKLAND), deps);
			expect(built).toEqual({ programId: expect.any(String), created: true });
			const stored = await getProgramVersion(owner, (built as { programId: string }).programId, 1, {
				db
			});
			expect([stored.startsOn, stored.firstPlannedDay]).toEqual(['2026-11-02', '2026-11-06']);
			expect(stored.version.inputFingerprint).toBe(shown.preview.fingerprint);
			expect(stored.version.catalogueDigest).toBe(shown.preview.digest);
		});
	});

	it('records the device’s zone on the profile, and a second identical build returns the same program', async () => {
		await withRollback(async (db) => {
			const owner = await readyOwner(db);
			const deps = { db, now: at() };
			const shown = await preview(owner, { timeZone: AUCKLAND, start: 'next_monday' }, deps);
			const first = await build(owner, confirm(shown, 'next_monday', AUCKLAND), deps);
			expect(first).toMatchObject({ created: true });
			expect((await getAthleteProfile(owner, { db })).timeZone).toBe(AUCKLAND);

			const again = await build(owner, confirm(shown, 'next_monday', AUCKLAND), deps);
			expect(again).toEqual({ ...(first as object), created: false });
			expect(await programs(db)).toBe(1);
		});
	});

	it('keeps the profile’s zone when the device sends none', async () => {
		await withRollback(async (db) => {
			const owner = await readyOwner(db, AUCKLAND);
			const deps = { db, now: at() };
			const shown = await preview(owner, { start: 'next_monday' }, deps);
			expect(await build(owner, confirm(shown, 'next_monday'), deps)).toMatchObject({
				created: true
			});
			expect((await getAthleteProfile(owner, { db })).timeZone).toBe(AUCKLAND);
		});
	});
});

describe('a build that no longer matches its preview', () => {
	/** The 409 the build was refused with: its reason, with nothing stored or recorded. */
	async function refused(db: Executor, owner: string, result: unknown): Promise<string> {
		expect(isActionFailure(result), JSON.stringify(result)).toBe(true);
		const { status, data } = result as { status: number; data: { reason: string } };
		expect(status).toBe(409);
		expect(await programs(db)).toBe(0);
		expect((await getAthleteProfile(owner, { db })).timeZone).toBe('UTC');
		return data.reason;
	}

	it("is 'profile' after a profile edit", async () => {
		await withRollback(async (db) => {
			const owner = await readyOwner(db);
			const deps = { db, now: at() };
			const shown = await preview(owner, { timeZone: AUCKLAND, start: 'next_monday' }, deps);
			await saveSchedule(owner, schedule(45), { db });
			const result = await build(owner, confirm(shown, 'next_monday', AUCKLAND), deps);
			expect(await refused(db, owner, result)).toBe('profile');
		});
	});

	it("is 'library' once the exercise library changed", async () => {
		await withRollback(async (db) => {
			const owner = await readyOwner(db);
			const shown = await preview(
				owner,
				{ timeZone: AUCKLAND, start: 'next_monday' },
				{ db, now: at() }
			);
			const [first, ...rest] = CATALOGUE;
			const catalogue = [{ ...first!, name: `${first!.name} (new wording)` }, ...rest];
			const result = await build(owner, confirm(shown, 'next_monday', AUCKLAND), {
				db,
				now: at(),
				catalogue
			});
			expect(await refused(db, owner, result)).toBe('library');
		});
	});

	it("is 'start_date' once the previewed day has passed in the device’s zone", async () => {
		await withRollback(async (db) => {
			const owner = await readyOwner(db);
			const shown = await preview(
				owner,
				{ timeZone: AUCKLAND, start: 'this_week' },
				{ db, now: at() }
			);
			// A day on: Saturday in Auckland, still Friday in UTC.
			const later = { db, now: at('2026-11-06T11:30:00Z') };
			const result = await build(owner, confirm(shown, 'this_week', AUCKLAND), later);
			expect(await refused(db, owner, result)).toBe('start_date');
		});
	});
});

describe('without the owner’s session', () => {
	it('refuses both actions with 401 and runs neither', async () => {
		await withRollback(async (db) => {
			const actions = buildActions({ db, now: at() });
			for (const action of ['preview', 'build'] as const) {
				const error = await actions[action]({
					locals: locals(null),
					request: post(action, { timeZone: AUCKLAND, start: 'next_monday' })
				}).then(
					() => null,
					(err: unknown) => err
				);
				expect(isHttpError(error, 401), action).toBe(true);
			}
			expect(await programs(db)).toBe(0);
		});
	});
});
