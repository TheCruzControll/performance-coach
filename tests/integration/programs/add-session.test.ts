/**
 * Adding a session to a planned week on real Postgres (src/lib/server/services/programs/add.ts):
 * the add is a new version through reviseProgram, copying only its week, with the session under a
 * new lineage, one session_added decision with its why, and the version it was made on unchanged.
 * A day that has passed, a day outside the program or a full day is refused at its field; a stale
 * version is a ProgramConflictError; the week's new warnings come back and never block the add.
 * The day's sessions are numbered again by time of day.
 *
 * The week runs Monday 9 to Sunday 15 November 2026 (the baseline week), then four accumulation
 * weeks; each call says which day is today.
 */
import { describe, expect, it } from 'vitest';
import { addDays, type IsoDate } from '../../../src/lib/domain/calendar';
import type { ProgramPlan } from '../../../src/lib/domain/training/types';
import type { Executor } from '../../../src/lib/server/db';
import {
	addApplier,
	addSession,
	createProgramFromPlan,
	getProgramVersion,
	getTrainingWeek,
	getVersionHistory,
	type EditAt,
	type ProgramVersion
} from '../../../src/lib/server/services/programs/index';
import {
	ProgramConflictError,
	TrainingInputError
} from '../../../src/lib/server/services/training/shared';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import {
	programFixture,
	type ProgramFixture
} from '../../../src/lib/server/test-support/program-fixtures';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const MONDAY = '2026-11-09';
/** The accumulation week after the baseline: Monday 16 to Sunday 22 November. */
const WEEK = addDays(MONDAY, 7);
const day = (n: number) => addDays(WEEK, n);
const [TUE, WED, THU, FRI, SAT, SUN] = [1, 2, 3, 4, 5, 6].map(day) as [
	IsoDate,
	IsoDate,
	IsoDate,
	IsoDate,
	IsoDate,
	IsoDate
];
/** The bridge fixture's own today: a Wednesday in its last unplanned week, in Los Angeles. */
const BRIDGE_DAY = '2026-11-18';
const TZ = 'America/Los_Angeles';
/** Tuesday 15 December: after the program's fifth week, which ends on Sunday 13 December. */
const AFTER_THE_PROGRAM = addDays(MONDAY, 7 * 5 + 1);

const plan = (fixture: ProgramFixture = 'hybrid'): ProgramPlan =>
	programFixture(fixture, { monday: MONDAY, today: MONDAY });

/** Store a fixture plan (the hybrid one unless named) as the owner's program, in the test's transaction. */
async function withProgram(db: Executor, fixture: ProgramFixture = 'hybrid') {
	const owner = await makeOwner(db);
	const { programId } = await createProgramFromPlan(
		owner,
		plan(fixture),
		{ source: 'rules' },
		{ db }
	);
	return { owner, programId };
}

/** An edit made on `version`, on `today`. */
const at = (version: number, today: IsoDate = MONDAY): EditAt => ({ version, today });

/** The sessions of version `version` on `date`, by their order in the day. */
function sessionsOn(version: ProgramVersion, date: IsoDate) {
	return version.blocks
		.flatMap((block) => block.weeks.flatMap((week) => week.sessions))
		.filter((session) => session.date === date)
		.sort((a, b) => a.orderInDay - b.orderInDay);
}

/** The week of version `version` that holds `date`. */
function weekOn(version: ProgramVersion, date: IsoDate) {
	const week = version.blocks
		.flatMap((block) => block.weeks)
		.find((w) => w.startsOn <= date && date <= w.endsOn);
	if (!week) throw new Error(`no week holds ${date}`);
	return week;
}

/** What the add did, or the error it threw (fails the test if it succeeded). */
async function thrown(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		(value) => {
			throw new Error(`expected the add to throw, it returned ${JSON.stringify(value)}`);
		},
		(err: unknown) => err
	);
}

describe('adding a session to a planned week', () => {
	it('writes version 2 with only that week copied, and the session under a lineage of its own', async () => {
		await withRollback(async (db) => {
			const { owner, programId } = await withProgram(db);
			const v1 = await getProgramVersion(owner, programId, 1, { db });
			const added = await addSession(owner, { date: WED, kind: 'run', intent: 'easy' }, at(1), {
				db
			});
			expect(added).toMatchObject({ programId, number: 2, lineage: expect.any(String) });
			const v2 = await getProgramVersion(owner, programId, 2, { db });

			const target = weekOn(v2, WED);
			const copied = weekOn(v1, WED);
			expect(target.lineage).toBe(copied.lineage);
			expect(target.id).not.toBe(copied.id);
			// Every other week is shared: the same row, and its sessions too.
			for (const week of v1.blocks.flatMap((b) => b.weeks)) {
				if (week.lineage === copied.lineage) continue;
				expect(weekOn(v2, week.startsOn).id).toBe(week.id);
			}

			const session = sessionsOn(v2, WED).find((s) => s.lineage === added.lineage);
			expect(session).toMatchObject({ kind: 'run', source: 'generator', status: 'planned' });
			expect(sessionsOn(v1, WED).some((s) => s.lineage === added.lineage)).toBe(false);
		});
	});

	it('stores the session the builder makes, with its own rows', async () => {
		await withRollback(async (db) => {
			const { owner, programId } = await withProgram(db);
			const input = { date: THU, kind: 'muay_thai', intent: 'hard', timeOfDay: 'evening' } as const;
			const { session } = await addApplier(owner, input, at(1), { db });
			const added = await addSession(owner, input, at(1), { db });
			const stored = sessionsOn(await getProgramVersion(owner, programId, 2, { db }), THU).find(
				(s) => s.lineage === added.lineage
			);
			expect(stored).toMatchObject({
				title: session.title,
				type: session.type,
				estMinutes: session.estMinutes,
				targetRpe: session.targetRpe,
				timeOfDay: 'evening',
				source: 'generator'
			});
			expect(stored?.kind).toBe('other');
			if (session.kind !== 'other' || stored?.kind !== 'other')
				throw new Error('not other sessions');
			expect(stored.details).toMatchObject(session.details);
		});
	});

	it('stores a strength session as its exercises with RPE-based sets', async () => {
		await withRollback(async (db) => {
			const { owner, programId } = await withProgram(db);
			const added = await addSession(owner, { date: FRI, kind: 'strength' }, at(1), { db });
			const stored = sessionsOn(await getProgramVersion(owner, programId, 2, { db }), FRI).find(
				(s) => s.lineage === added.lineage
			);
			expect(stored?.kind).toBe('strength');
			if (stored?.kind !== 'strength') return;
			expect(stored.exercises.length).toBeGreaterThan(0);
			for (const exercise of stored.exercises) {
				expect(exercise.sets.length).toBeGreaterThan(0);
				for (const set of exercise.sets) {
					expect(set.loadKind).toBe('rpe_based');
					expect(set.targetRpe).toBeLessThanOrEqual(stored.targetRpe);
				}
			}
		});
	});

	it('records a session_added decision with its why and leaves version 1 as it was', async () => {
		await withRollback(async (db) => {
			const { owner, programId } = await withProgram(db);
			const v1 = await getProgramVersion(owner, programId, 1, { db });
			const added = await addSession(
				owner,
				{ date: WED, kind: 'run', reason: 'Feeling fresh' },
				at(1),
				{
					db
				}
			);
			const v2 = await getProgramVersion(owner, programId, 2, { db });
			const decision = v2.decisions.find((d) => d.kind === 'session_added');
			expect(decision).toMatchObject({
				kind: 'session_added',
				decidedBy: 'owner',
				affected: [added.lineage],
				evidence: { date: WED, kind: 'run', intent: 'easy' }
			});
			expect(decision?.why).toContain('Feeling fresh');
			expect(decision?.why.length).toBeGreaterThan(0);

			// Version 1 is what it was, apart from no longer being the current one.
			expect(await getProgramVersion(owner, programId, 1, { db })).toEqual({
				...v1,
				version: { ...v1.version, current: false }
			});
			expect((await getVersionHistory(owner, {}, { db }))?.versions.map((v) => v.number)).toEqual([
				2, 1
			]);
		});
	});

	it('refuses a day that has passed, at its date, and writes nothing', async () => {
		await withRollback(async (db) => {
			const { owner, programId } = await withProgram(db);
			const err = await thrown(addSession(owner, { date: TUE, kind: 'run' }, at(1, WED), { db }));
			expect(err).toBeInstanceOf(TrainingInputError);
			expect((err as TrainingInputError).errors).toEqual({ date: 'That day has passed' });
			expect((await getVersionHistory(owner, {}, { db }))?.versions).toHaveLength(1);
			expect((await getProgramVersion(owner, programId, 1, { db })).version.number).toBe(1);
		});
	});

	it('refuses a day outside the program, at its date', async () => {
		await withRollback(async (db) => {
			const { owner } = await withProgram(db);
			const err = await thrown(
				addSession(owner, { date: AFTER_THE_PROGRAM, kind: 'run' }, at(1), { db })
			);
			expect((err as TrainingInputError).errors).toEqual({ date: 'Pick a day in your program' });
		});
	});

	it('refuses a day in an outline week, at its date', async () => {
		await withRollback(async (db) => {
			// The one-week plan's second block is an outline: its weeks hold no sessions and take no add.
			const { owner } = await withProgram(db, 'one-week');
			const err = await thrown(addSession(owner, { date: TUE, kind: 'run' }, at(1), { db }));
			expect(err).toBeInstanceOf(TrainingInputError);
			expect((err as TrainingInputError).errors).toEqual({ date: 'Pick a day in your program' });
		});
	});

	it('refuses a day in a bridge week, at its date', async () => {
		await withRollback(async (db) => {
			// Base, then three unplanned weeks before Build: the 18th is in the last of them.
			const owner = await makeOwner(db);
			const now = atLocal(BRIDGE_DAY, '12:00', TZ);
			await seedAnalyticsFixture(owner, 'bridge-week', { timeZone: TZ, now }, { db });
			const week = await getTrainingWeek(owner, { date: BRIDGE_DAY }, {}, { db });
			expect(week).toMatchObject({ planned: true, kind: 'unplanned' });
			const err = await thrown(
				addSession(owner, { date: BRIDGE_DAY, kind: 'run' }, at(week!.version.number, BRIDGE_DAY), {
					db
				})
			);
			expect(err).toBeInstanceOf(TrainingInputError);
			expect((err as TrainingInputError).errors).toEqual({ date: 'Pick a day in your program' });
		});
	});

	it('refuses a fifth session on a day, at its date', async () => {
		await withRollback(async (db) => {
			const { owner, programId } = await withProgram(db);
			// Thursday holds two of the week's sessions: two more fill it.
			const held = sessionsOn(await getProgramVersion(owner, programId, 1, { db }), THU).length;
			let version = 1;
			for (let n = held; n < 4; n++) {
				version = (await addSession(owner, { date: THU, kind: 'run' }, at(version), { db })).number;
			}
			const err = await thrown(addSession(owner, { date: THU, kind: 'run' }, at(version), { db }));
			expect((err as TrainingInputError).errors).toEqual({
				date: 'That day already has four sessions'
			});
			expect(
				sessionsOn(await getProgramVersion(owner, programId, version, { db }), THU)
			).toHaveLength(4);
		});
	});

	it('refuses a moderate run under 30 minutes at its length', async () => {
		await withRollback(async (db) => {
			const { owner } = await withProgram(db);
			const err = await thrown(
				addSession(
					owner,
					{ date: SAT, kind: 'run', intent: 'moderate', durationMinutes: 20 },
					at(1),
					{ db }
				)
			);
			expect((err as TrainingInputError).errors).toEqual({
				durationMinutes: 'A moderate or hard run needs at least 30 minutes'
			});
		});
	});

	it('refuses a stale version as a conflict, and writes nothing more', async () => {
		await withRollback(async (db) => {
			const { owner, programId } = await withProgram(db);
			await addSession(owner, { date: SUN, kind: 'conditioning' }, at(1), { db });
			const err = await thrown(
				addSession(owner, { date: SUN, kind: 'conditioning' }, at(1), { db })
			);
			expect(err).toBeInstanceOf(ProgramConflictError);
			expect((await getProgramVersion(owner, programId, 2, { db })).version.number).toBe(2);
			expect((await getVersionHistory(owner, {}, { db }))?.versions).toHaveLength(2);
		});
	});

	it('returns the week’s new warnings and still writes the version', async () => {
		await withRollback(async (db) => {
			const { owner, programId } = await withProgram(db);
			const added = await addSession(
				owner,
				{ date: TUE, kind: 'run', intent: 'hard', durationMinutes: 60 },
				at(1),
				{ db }
			);
			expect(added.number).toBe(2);
			// Three hard days in a row: the week's findings, which the add does not stop.
			expect(added.warnings.length).toBeGreaterThan(0);
			const v2 = await getProgramVersion(owner, programId, 2, { db });
			const decision = v2.decisions.find((d) => d.kind === 'session_added');
			// The why names the first of them; the rest are counted when the sentence is full.
			expect(decision?.why).toContain(added.warnings[0]!.message);
		});
	});

	it('numbers the day again by time of day', async () => {
		await withRollback(async (db) => {
			const { owner, programId } = await withProgram(db);
			// Friday holds nothing: three adds show where each goes.
			let version = 1;
			version = (
				await addSession(
					owner,
					{ date: FRI, kind: 'conditioning', timeOfDay: 'morning' },
					at(version),
					{ db }
				)
			).number;
			version = (
				await addSession(
					owner,
					{ date: FRI, kind: 'conditioning', timeOfDay: 'evening' },
					at(version),
					{ db }
				)
			).number;
			const early = await addSession(
				owner,
				{ date: FRI, kind: 'conditioning', timeOfDay: 'early_morning' },
				at(version),
				{ db }
			);
			const order = sessionsOn(
				await getProgramVersion(owner, programId, early.number, { db }),
				FRI
			);
			expect(order.map((s) => s.lineage)[0]).toBe(early.lineage);
			expect(order.map((s) => s.orderInDay)).toEqual([1, 2, 3]);
			expect(order.map((s) => s.timeOfDay)).toEqual(['early_morning', 'morning', 'evening']);
		});
	});
});
