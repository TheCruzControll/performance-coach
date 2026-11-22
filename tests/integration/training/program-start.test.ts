/**
 * Moving the program's start (services/programming/move.ts; Train's Start date screen,
 * src/routes/(app)/train/start) on real Postgres, through the real build and generator:
 * - a move is the program's next version, by the owner, planned again from the profile for the new
 *   dates: Train, Today and History read it at once, version 1 keeps its dates and rows, and moving
 *   back gives the first dates again
 * - a dated event keeps its date: the taper stays in the event's week, never shifted past it
 * - refused, writing nothing: a stale version, a start not offered or the current one, a start
 *   whose first planned day has passed or that has training logged against it, and an unfinished
 *   setup
 * - the screen's load and ?/move: the setup card before onboarding, the no-program card, the
 *   date field and its events, and the move's answer or its refusal.
 * - a first program on a day of the window, through the preview and the build
 */
import { isActionFailure } from '@sveltejs/kit';
import { eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { mondayOf } from '../../../src/lib/domain/calendar';
import { athleteProfiles, type Executor } from '../../../src/lib/server/db';
import {
	completeOnboarding,
	createGoal,
	saveSchedule
} from '../../../src/lib/server/services/profile';
import {
	ALREADY_THEN,
	buildProgram,
	getStartMove,
	moveProgramStart,
	NOT_OFFERED,
	PICK_A_DAY,
	previewProgram,
	ProgrammingConflictError,
	StartMoveError
} from '../../../src/lib/server/services/programming/index';
import {
	getCurrentProgram,
	getProgramVersion,
	getTodayPlan,
	getTrainingWeek,
	getVersionHistory,
	type ProgramVersion
} from '../../../src/lib/server/services/programs/index';
import { startWorkout } from '../../../src/lib/server/services/training/log';
import {
	ProgramConflictError,
	TrainingInputError
} from '../../../src/lib/server/services/training/shared';
import {
	loadStart,
	NO_PROGRAM_CARD,
	SETUP_CARD,
	startActions
} from '../../../src/routes/(app)/train/start/start.server';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

/** A Thursday: the build's 'next_monday' starts on 9 November. */
const TODAY = '2026-11-05';
const NOW = new Date('2026-11-05T10:00:00Z');
const BUILT_ON = '2026-11-09';
const LATER = '2026-11-16';
/** The last day of the window: today plus 56 days. */
const LATEST = '2026-12-31';
const ORIGIN = {
	requestId: 'test',
	method: 'GET',
	path: '/train/start',
	routeId: '/(app)/train/start',
	appVersion: 'test'
};

const schedule = {
	daysPerWeek: 3,
	availableDays: [],
	preferredTimes: [],
	sessionMinutes: null,
	constraints: null,
	commitments: []
};

const general = {
	kind: 'general',
	title: 'Get stronger',
	disciplines: ['strength'],
	focus: 'Get stronger',
	measure: 'Train every planned week'
};

/** A finished setup (one goal and a schedule, `event` first if given), with no program yet. */
async function readyOwner(db: Executor, { event }: { event?: string } = {}): Promise<string> {
	const owner = await makeOwner(db);
	if (event) {
		await createGoal(
			owner,
			{
				kind: 'event',
				title: 'Meet',
				disciplines: ['strength'],
				eventType: 'Powerlifting meet',
				eventDate: event
			},
			{ db }
		);
	}
	await createGoal(owner, general, { db });
	await saveSchedule(owner, schedule, { db });
	await completeOnboarding(owner, { db });
	return owner;
}

/** The program Today's Build stores for 'next_monday', previewed on TODAY. */
async function built(db: Executor, owner: string): Promise<string> {
	const preview = await previewProgram(owner, { today: TODAY, start: 'next_monday' }, { db });
	const { programId } = await buildProgram(
		owner,
		{
			today: TODAY,
			start: 'next_monday',
			startsOn: preview.startsOn,
			firstPlannedDay: preview.firstPlannedDay,
			fingerprint: preview.fingerprint,
			digest: preview.digest
		},
		{ db }
	);
	return programId;
}

const move = (db: Executor, owner: string, start: string, base = 1, today = TODAY) =>
	moveProgramStart(owner, { today, baseVersionNumber: base, start }, { db, now: () => NOW });

const sessionsOf = (v: ProgramVersion) =>
	v.blocks.flatMap((b) => b.weeks.flatMap((w) => w.sessions));
const blockIds = (v: ProgramVersion) => v.blocks.map((b) => b.id);

async function counts(db: Executor) {
	const { rows } = await db.execute<{ versions: number; decisions: number }>(
		sql`select (select count(*)::int from program_versions) as versions,
			(select count(*)::int from programming_decisions) as decisions`
	);
	return rows[0]!;
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
	const error = await promise.then(
		() => null,
		(err: unknown) => err
	);
	if (!error) throw new Error('expected the move to be refused');
	return error;
}

describe('moving the start', () => {
	it('is the next version, planned again for the new dates; Train, Today and History read it', async () => {
		await withRollback(async (db) => {
			const owner = await readyOwner(db);
			const programId = await built(db, owner);
			const v1 = await getProgramVersion(owner, programId, 1, { db });

			const moved = await move(db, owner, LATER);
			expect(moved).toMatchObject({
				programId,
				number: 2,
				startsOn: LATER,
				firstPlannedDay: LATER,
				from: { startsOn: BUILT_ON, firstPlannedDay: BUILT_ON }
			});

			const v2 = await getProgramVersion(owner, programId, 2, { db });
			expect(v2.version).toMatchObject({
				createdBy: 'owner',
				summary: 'Moved the start to Mon 16 Nov',
				current: true
			});
			expect([v2.startsOn, v2.firstPlannedDay]).toEqual([LATER, LATER]);
			expect(v2.blocks[0]!.startsOn).toBe(LATER);
			expect(sessionsOf(v2).every((s) => s.date >= LATER)).toBe(true);
			// Each session a week later, the same week shape: the profile did not change.
			expect(sessionsOf(v2).map((s) => [s.title, s.date])).toEqual(
				sessionsOf(v1).map((s) => [
					s.title,
					new Date(Date.parse(s.date) + 7 * 86_400_000).toISOString().slice(0, 10)
				])
			);
			// Nothing is shared: every block is a new row, and version 1 keeps its own.
			expect(blockIds(v2).some((id) => blockIds(v1).includes(id))).toBe(false);
			const before = await getProgramVersion(owner, programId, 1, { db });
			expect([before.startsOn, blockIds(before)]).toEqual([BUILT_ON, blockIds(v1)]);
			// The move first, then the generator's decisions for the new plan.
			expect(v2.decisions[0]).toMatchObject({
				kind: 'start_moved',
				decidedBy: 'owner',
				summary: 'Moved the start to Mon 16 Nov',
				why: expect.stringContaining('You moved the start from Mon 9 Nov to Mon 16 Nov')
			});
			expect(v2.decisions.some((d) => d.kind === 'program_purpose')).toBe(true);

			// Train, Today and History.
			const current = await getCurrentProgram(owner, TODAY, { db });
			expect(current).toMatchObject({ startsOn: LATER, firstPlannedDay: LATER, notStarted: true });
			const week = await getTrainingWeek(owner, { date: TODAY }, {}, { db });
			expect(week).toMatchObject({ startsOn: LATER, programStartsOn: LATER });
			expect((await getTodayPlan(owner, TODAY, { db }))?.startsOn).toBe(LATER);
			const history = await getVersionHistory(owner, {}, { db });
			expect(history?.versions.map((v) => [v.number, v.summary, v.current])).toEqual([
				[2, 'Moved the start to Mon 16 Nov', true],
				[1, 'Your first program', false]
			]);
			expect(history?.versions[0]!.decisions[0]!.kind).toBe('start_moved');
		});
	});

	it('moves back to where it was, and to this week from today', async () => {
		await withRollback(async (db) => {
			const owner = await readyOwner(db);
			const programId = await built(db, owner);
			const v1 = await getProgramVersion(owner, programId, 1, { db });
			await move(db, owner, LATER);
			await move(db, owner, BUILT_ON, 2);
			const v3 = await getProgramVersion(owner, programId, 3, { db });
			expect(v3.version.summary).toBe('Moved the start to Mon 9 Nov');
			expect(sessionsOf(v3).map((s) => [s.title, s.date])).toEqual(
				sessionsOf(v1).map((s) => [s.title, s.date])
			);

			await move(db, owner, TODAY, 3);
			const v4 = await getProgramVersion(owner, programId, 4, { db });
			expect([v4.startsOn, v4.firstPlannedDay]).toEqual(['2026-11-02', TODAY]);
			expect(v4.version.summary).toBe('Moved the start to Thu 5 Nov');
			expect(sessionsOf(v4).every((s) => s.date >= TODAY)).toBe(true);
		});
	});

	it('to any day: a Thursday two weeks out, then the last day of the window', async () => {
		await withRollback(async (db) => {
			const owner = await readyOwner(db);
			const programId = await built(db, owner);
			const moved = await move(db, owner, '2026-11-19');
			expect(moved).toMatchObject({
				number: 2,
				startsOn: LATER,
				firstPlannedDay: '2026-11-19',
				from: { startsOn: BUILT_ON, firstPlannedDay: BUILT_ON }
			});

			const v2 = await getProgramVersion(owner, programId, 2, { db });
			expect([v2.startsOn, v2.firstPlannedDay]).toEqual([LATER, '2026-11-19']);
			expect(sessionsOf(v2).every((s) => s.date >= '2026-11-19')).toBe(true);
			for (const week of v2.blocks.flatMap((b) => b.weeks)) {
				expect(mondayOf(week.startsOn)).toBe(week.startsOn);
			}
			expect(v2.version.summary).toBe('Moved the start to Thu 19 Nov');
			expect(v2.decisions[0]).toMatchObject({
				kind: 'start_moved',
				summary: 'Moved the start to Thu 19 Nov'
			});

			// Train and Today read the new first day.
			const week = await getTrainingWeek(owner, { date: TODAY }, {}, { db });
			expect(week).toMatchObject({ startsOn: LATER, programStartsOn: '2026-11-19' });
			expect((await getTodayPlan(owner, TODAY, { db }))?.startsOn).toBe('2026-11-19');

			// The last day of the window is accepted too.
			await move(db, owner, LATEST, 2);
			const v3 = await getProgramVersion(owner, programId, 3, { db });
			expect([v3.startsOn, v3.firstPlannedDay]).toEqual(['2026-12-28', LATEST]);
		});
	});

	it('keeps a dated event on its date: the taper stays in its week, never past it', async () => {
		await withRollback(async (db) => {
			const MEET = '2026-12-12'; // Saturday of the 5th week from 9 November
			const owner = await readyOwner(db, { event: MEET });
			const programId = await built(db, owner);
			await move(db, owner, LATER);
			const [v1, v2] = [
				await getProgramVersion(owner, programId, 1, { db }),
				await getProgramVersion(owner, programId, 2, { db })
			];
			// The season plans the meet's run-up phase by phase (periodisation/strength.ts), the first
			// phase with its weeks: 4 weeks out, a novice's accumulation is 1 week, week 1's baseline;
			// 3 weeks out it is cut, and intensification leads with the baseline.
			const road = (v: ProgramVersion) => v.blocks.map((b) => [b.phase, b.startsOn, b.endsOn]);
			expect(v1.blocks[0]!.weeks.map((w) => w.kind)).toEqual(['baseline']);
			expect(v2.blocks[0]!.weeks.map((w) => w.kind)).toEqual(['baseline', 'intensification']);
			expect(road(v1).slice(0, 3)).toEqual([
				['accumulation', BUILT_ON, '2026-11-15'],
				['intensification', LATER, '2026-11-29'],
				['taper', '2026-11-30', '2026-12-13']
			]);
			expect(road(v2).slice(0, 2)).toEqual([
				['intensification', LATER, '2026-11-29'],
				['taper', '2026-11-30', '2026-12-13']
			]);
			// The run-up is a week shorter and still ends on the meet's Sunday; the 1-week taper
			// before the meet is the same in both, never shifted past it.
			const taper = (v: ProgramVersion) =>
				v.decisions.filter((d) => d.kind === 'taper_planned').map((d) => d.summary);
			expect(taper(v1)).toEqual(['Taper before Meet: 1 week']);
			expect(taper(v2)).toEqual(taper(v1));
			expect(v2.blocks[2]!.startsOn).toBe('2026-12-14');
		});
	});
});

describe('a move refused, writing nothing', () => {
	it('from a version that is no longer current', async () => {
		await withRollback(async (db) => {
			const owner = await readyOwner(db);
			await built(db, owner);
			await move(db, owner, LATER);
			const before = await counts(db);
			expect(await refusal(move(db, owner, '2026-11-23', 1))).toBeInstanceOf(ProgramConflictError);
			expect(await counts(db)).toEqual(before);
		});
	});

	it('to a start the move does not offer, or to the current one', async () => {
		await withRollback(async (db) => {
			const owner = await readyOwner(db);
			await built(db, owner);
			const before = await counts(db);
			for (const start of [
				'2026-11-04',
				'2027-01-01',
				'2027-03-01',
				'this_week',
				'next_monday',
				'2026-02-30',
				''
			]) {
				const error = await refusal(move(db, owner, start));
				expect(error, start).toBeInstanceOf(TrainingInputError);
				expect((error as TrainingInputError).errors).toEqual({ start: NOT_OFFERED });
			}
			const same = await refusal(move(db, owner, BUILT_ON));
			expect((same as TrainingInputError).errors).toEqual({ start: ALREADY_THEN });
			expect(await counts(db)).toEqual(before);
		});
	});

	it('once its first planned day has passed, but not on that day', async () => {
		await withRollback(async (db) => {
			const owner = await readyOwner(db);
			await built(db, owner);
			const before = await counts(db);
			const started = await refusal(move(db, owner, LATER, 1, '2026-11-10'));
			expect(started).toBeInstanceOf(StartMoveError);
			expect((started as StartMoveError).reason).toBe('started');
			expect(await counts(db)).toEqual(before);
			expect(await getStartMove(owner, '2026-11-10', { db })).toMatchObject({
				refusal: 'started',
				window: null
			});
			// On the first planned day itself, nothing is logged yet: it still moves.
			await move(db, owner, LATER, 1, BUILT_ON);
		});
	});

	it('once a workout is logged against the program, even before its first planned day', async () => {
		await withRollback(async (db) => {
			const owner = await readyOwner(db);
			const programId = await built(db, owner);
			const session = sessionsOf(await getProgramVersion(owner, programId, 1, { db }))[0]!;
			await startWorkout(
				owner,
				{
					clientId: crypto.randomUUID(),
					kind: session.kind,
					discipline: session.discipline,
					sessionType: session.type,
					title: session.title,
					plannedSessionId: session.id,
					startedAt: NOW.toISOString()
				},
				{ db }
			);
			const before = await counts(db);
			const logged = await refusal(move(db, owner, LATER));
			expect((logged as StartMoveError).reason).toBe('logged');
			expect(await counts(db)).toEqual(before);
			expect((await getStartMove(owner, TODAY, { db }))?.refusal).toBe('logged');
		});
	});

	it('while setup is unfinished (the build refuses it the same way)', async () => {
		await withRollback(async (db) => {
			const owner = await readyOwner(db);
			await built(db, owner);
			// Onboarding never comes undone in the app: the test undoes it.
			await db
				.update(athleteProfiles)
				.set({ onboardingCompletedAt: null })
				.where(eq(athleteProfiles.ownerId, owner));
			const before = await counts(db);
			const error = await refusal(move(db, owner, LATER));
			expect((error as TrainingInputError).errors).toEqual({
				onboarding: 'Finish setting up your profile first'
			});
			expect(await counts(db)).toEqual(before);
		});
	});
});

describe('a first program on any day', () => {
	const THURSDAY = '2026-11-12';
	const shown = (db: Executor, owner: string, today: string, start: string) =>
		previewProgram(owner, { today, start }, { db });

	it('previews a start on a day of the window: its week from Monday, with nothing before the day', async () => {
		await withRollback(async (db) => {
			const owner = await readyOwner(db);
			const preview = await shown(db, owner, TODAY, THURSDAY);
			expect([preview.startsOn, preview.firstPlannedDay]).toEqual(['2026-11-09', THURSDAY]);
			expect(preview.week.days.filter((d) => d.date < THURSDAY).flatMap((d) => d.sessions)).toEqual(
				[]
			);
		});
	});

	it('builds the previewed day: version 1 keeps the same dates', async () => {
		await withRollback(async (db) => {
			const owner = await readyOwner(db);
			const preview = await shown(db, owner, TODAY, THURSDAY);
			await buildProgram(
				owner,
				{
					today: TODAY,
					start: THURSDAY,
					startsOn: preview.startsOn,
					firstPlannedDay: preview.firstPlannedDay,
					fingerprint: preview.fingerprint,
					digest: preview.digest
				},
				{ db }
			);
			expect(await getCurrentProgram(owner, TODAY, { db })).toMatchObject({
				startsOn: '2026-11-09',
				firstPlannedDay: THURSDAY
			});
		});
	});

	it('refuses a preview outside the window, naming the field', async () => {
		await withRollback(async (db) => {
			const owner = await readyOwner(db);
			for (const start of ['2026-11-04', '2027-01-01']) {
				const error = await refusal(shown(db, owner, TODAY, start));
				expect(error, start).toBeInstanceOf(TrainingInputError);
				expect((error as TrainingInputError).errors, start).toEqual({ start: PICK_A_DAY });
			}
		});
	});

	it('refuses a build whose dates the preview did not give, or whose day has passed, writing nothing', async () => {
		await withRollback(async (db) => {
			const owner = await readyOwner(db);
			const preview = await shown(db, owner, TODAY, THURSDAY);
			const confirm = {
				today: TODAY,
				start: THURSDAY,
				startsOn: preview.startsOn,
				firstPlannedDay: preview.firstPlannedDay,
				fingerprint: preview.fingerprint,
				digest: preview.digest
			};
			const before = await counts(db);

			const other = await refusal(
				buildProgram(owner, { ...confirm, firstPlannedDay: '2026-11-13' }, { db })
			);
			expect(other).toBeInstanceOf(TrainingInputError);
			expect(Object.keys((other as TrainingInputError).errors)).toEqual(['firstPlannedDay']);

			const passed = await refusal(
				buildProgram(owner, { ...confirm, today: '2026-11-13' }, { db })
			);
			expect(passed).toBeInstanceOf(ProgrammingConflictError);
			expect((passed as ProgrammingConflictError).reason).toBe('start_date');

			expect(await counts(db)).toEqual(before);
		});
	});
});

describe('the Start date screen', () => {
	const load = (db: Executor, owner: string) =>
		loadStart(owner, { now: NOW, origin: ORIGIN }, { db, errorsDb: db });

	function locals(ownerId: string): App.Locals {
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

	const post = (fields: Record<string, string>) => {
		const body = new FormData();
		for (const [k, v] of Object.entries(fields)) body.set(k, v);
		return new Request('http://localhost/train/start?/move', { method: 'POST', body });
	};

	it('says what comes first before setup is done, and with no program', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			expect(await load(db, owner)).toEqual({ state: 'card', card: SETUP_CARD });
			await createGoal(owner, general, { db });
			await saveSchedule(owner, schedule, { db });
			expect(await load(db, owner)).toEqual({ state: 'card', card: SETUP_CARD });
			await completeOnboarding(owner, { db });
			expect(await load(db, owner)).toEqual({ state: 'card', card: NO_PROGRAM_CARD });
		});
	});

	it('offers any day from today to eight weeks ahead, the current start filled in, and names the events in the window', async () => {
		await withRollback(async (db) => {
			const owner = await readyOwner(db, { event: '2026-11-21' });
			await built(db, owner);
			expect(await load(db, owner)).toEqual({
				state: 'open',
				version: 1,
				current: 'Week 1 starts Monday 9 November.',
				day: BUILT_ON,
				min: TODAY,
				max: LATEST,
				hint: 'Any day from today to Thu 31 Dec. Week 1 runs to that Sunday, so a later day plans less of it.',
				events: ['Meet is Sat 21 Nov: a start after it no longer plans for it.']
			});
		});
	});

	it('moves the start through ?/move and answers the toast’s words; a stale version is a 409', async () => {
		await withRollback(async (db) => {
			const owner = await readyOwner(db);
			await built(db, owner);
			const actions = startActions({ db, now: () => NOW });
			const answer = await actions.move({
				locals: locals(owner),
				request: post({ version: '1', start: LATER })
			});
			expect(answer).toEqual({
				words: 'Start moved to Mon 16 Nov · version 2',
				href: '/train',
				firstPlannedDay: LATER
			});
			const stale = await actions.move({
				locals: locals(owner),
				request: post({ version: '1', start: '2026-11-23' })
			});
			expect(isActionFailure(stale) && [stale.status, stale.data]).toEqual([
				409,
				{ reason: 'version' }
			]);
			const unknown = await actions.move({
				locals: locals(owner),
				request: post({ version: '2', start: '2027-01-04' })
			});
			expect(isActionFailure(unknown) && [unknown.status, unknown.data]).toEqual([
				400,
				{ errors: { start: NOT_OFFERED } }
			]);
			const tuesday = await actions.move({
				locals: locals(owner),
				request: post({ version: '2', start: '2026-11-17' })
			});
			expect(tuesday).toEqual({
				words: 'Start moved to Tue 17 Nov · version 3',
				href: '/train',
				firstPlannedDay: '2026-11-17'
			});
		});
	});

	it('says why once the program has started', async () => {
		await withRollback(async (db) => {
			const owner = await readyOwner(db);
			await built(db, owner);
			const data = await loadStart(
				owner,
				{ now: new Date('2026-11-12T10:00:00Z'), origin: ORIGIN },
				{ db, errorsDb: db }
			);
			expect(data).toMatchObject({
				state: 'card',
				card: {
					id: 'start-fixed',
					title: 'Your program has started',
					description: expect.stringContaining('Week 1 began Monday 9 November.')
				}
			});
		});
	});
});
