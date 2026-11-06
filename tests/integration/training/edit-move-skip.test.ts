/**
 * Moving and skipping a planned session on real Postgres (src/lib/server/services/programs/
 * edits.ts): each edit is a new version through reviseProgram, with one decision whose 'why' is
 * never empty, and every older version stays as it was. Only a session dated today or later can
 * be edited, a move stays within its week and lands on a day from today on, and a move that
 * breaks an interference rule goes ahead with the warning returned and recorded.
 *
 * Every date is explicit: the week runs Monday 9 to Sunday 15 November 2026, and each call says
 * which of its days is today.
 */
import { describe, expect, it } from 'vitest';
import { addDays } from '../../../src/lib/domain/calendar';
import { BLOCKS_EDIT, type Severity } from '../../../src/lib/domain/programming/interference';
import type {
	ProgramPlan,
	SessionPlan,
	SetPrescription,
	WeekPlan
} from '../../../src/lib/domain/training/types';
import { workouts, type Executor } from '../../../src/lib/server/db';
import {
	checkMove,
	createProgramFromPlan,
	getMoveTargets,
	getProgramVersion,
	getVersionHistory,
	moveSession,
	skipSession,
	type ProgramVersion,
	type StoredSession
} from '../../../src/lib/server/services/programs/index';
import {
	ProgramConflictError,
	TrainingInputError,
	TrainingNotFoundError,
	type ConflictError
} from '../../../src/lib/server/services/training/shared';
import {
	FIXTURE_COMMITMENT,
	FIXTURE_GOAL
} from '../../../src/lib/server/test-support/program-fixtures';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const MONDAY = '2026-11-09';
const day = (n: number) => addDays(MONDAY, n);
const [MON, TUE, WED, THU, FRI, SAT, SUN] = [0, 1, 2, 3, 4, 5, 6].map(day) as [
	string,
	string,
	string,
	string,
	string,
	string,
	string
];

// ---- the plan -------------------------------------------------------------------------------

const set = (over: Partial<SetPrescription>): SetPrescription => ({
	role: 'working',
	sets: 3,
	repsMin: 5,
	repsMax: 5,
	seconds: null,
	metres: null,
	targetRpe: 7,
	loadKind: 'rpe_based',
	loadValue: null,
	loadUnit: null,
	loadBasis: null,
	reference1rm: null,
	reference1rmUnit: null,
	restSeconds: 120,
	tempo: null,
	notes: null,
	...over
});

const base = (date: string, title: string, minutes: number, rpe: number) => ({
	date,
	title,
	timeOfDay: 'morning' as const,
	orderInDay: 1,
	customDiscipline: null,
	estMinutes: minutes,
	estLoad: minutes * rpe,
	targetRpe: rpe,
	source: 'generator' as const,
	commitmentRef: null,
	instructions: null,
	notes: null
});

/** Heavy lower body: a hard back-squat session, its top set at RPE 8. */
const lowerBody = (date: string, title = 'Lower A'): SessionPlan => ({
	...base(date, title, 60, 8),
	kind: 'strength',
	type: 'strength',
	discipline: 'strength',
	intensity: 'hard',
	exercises: [
		{
			exercise: { key: 'back_squat' },
			baselineLift: null,
			superset: null,
			substitutedFrom: null,
			substitutionReason: null,
			instructions: null,
			notes: null,
			sets: [set({ role: 'top', sets: 1, targetRpe: 8 }), set({ role: 'back_off' })]
		}
	]
});

/** A moderate upper-body session, hard by nothing it holds. */
const upperBody = (date: string): SessionPlan => ({
	...base(date, 'Upper A', 60, 7),
	kind: 'strength',
	type: 'strength',
	discipline: 'strength',
	intensity: 'moderate',
	exercises: [
		{
			exercise: { key: 'bench_press' },
			baselineLift: null,
			superset: null,
			substitutedFrom: null,
			substitutionReason: null,
			instructions: null,
			notes: null,
			sets: [set({})]
		}
	]
});

const run = (date: string, type: 'easy_run' | 'long_run'): SessionPlan => {
	const minutes = type === 'long_run' ? 100 : 30;
	return {
		...base(date, type === 'long_run' ? 'Long run' : 'Easy run', minutes, 4),
		kind: 'run',
		type,
		discipline: 'running',
		intensity: type === 'long_run' ? 'moderate' : 'easy',
		segments: [
			{
				kind: type === 'long_run' ? 'long' : 'easy',
				repeatGroup: null,
				repeats: null,
				distanceMetres: null,
				durationSeconds: minutes * 60,
				paceMinSecondsPerKm: null,
				paceMaxSecondsPerKm: null,
				hrZone: 2,
				targetRpe: 4
			}
		]
	};
};

const mobility = (date: string): SessionPlan => ({
	...base(date, 'Mobility', 20, 3),
	kind: 'other',
	type: 'mobility',
	discipline: 'athletic',
	intensity: 'easy',
	details: { kind: 'mobility', durationMinutes: 20, targetRpe: 3, metrics: [], notes: null }
});

/** Hard Muay Thai sparring, a fixed evening commitment. */
const sparring = (
	date: string,
	{ title = 'Sparring', timeOfDay = 'evening', orderInDay = 1 } = {}
): SessionPlan => ({
	...base(date, title, 60, 8),
	kind: 'other',
	timeOfDay: timeOfDay as SessionPlan['timeOfDay'],
	orderInDay,
	type: 'muay_thai',
	discipline: 'muay_thai',
	intensity: 'hard',
	source: 'commitment',
	commitmentRef: FIXTURE_COMMITMENT,
	details: { kind: 'sparring', durationMinutes: 60, targetRpe: 8, metrics: [], notes: null }
});

const week = (startsOn: string, sessions: SessionPlan[]): WeekPlan => ({
	kind: 'baseline',
	startsOn,
	endsOn: addDays(startsOn, 6),
	targets: { rpeCap: 8, volumeFactor: 1, loadStep: 0, runVolumeFactor: 1 },
	sessions
});

/**
 * Two planned weeks alike: Lower A on Monday, an easy run on Tuesday, Wednesday free, Upper A on
 * Thursday, mobility on Friday, sparring on Saturday evening and a long run on Sunday.
 */
const standardWeek = (monday: string) => {
	const d = (n: number) => addDays(monday, n);
	return week(monday, [
		lowerBody(d(0)),
		run(d(1), 'easy_run'),
		upperBody(d(3)),
		mobility(d(4)),
		sparring(d(5)),
		run(d(6), 'long_run')
	]);
};

function plan(weeks: WeekPlan[]): ProgramPlan {
	return {
		title: 'Edits fixture',
		startsOn: MONDAY,
		firstPlannedDay: MONDAY,
		blocks: [
			{
				phase: 'baseline',
				name: 'Baseline',
				startsOn: MONDAY,
				endsOn: weeks.at(-1)!.endsOn,
				outline: false,
				goalRefs: [FIXTURE_GOAL],
				progression: {},
				weeks
			}
		],
		decisions: [
			{
				kind: 'program_purpose',
				ruleKey: 'blocks.baseline_first',
				summary: 'Week 1 establishes your baselines',
				why: 'Your working weights are not known yet.',
				decidedBy: 'rules',
				refs: ['blocks.0'],
				evidence: {}
			}
		]
	};
}

async function store(
	db: Executor,
	owner: string,
	weeks = [standardWeek(MONDAY), standardWeek(day(7))]
) {
	const created = await createProgramFromPlan(owner, plan(weeks), { source: 'rules' }, { db });
	return created.programId;
}

const versionOf = (db: Executor, owner: string, programId: string, n: number) =>
	getProgramVersion(owner, programId, n, { db });

/** Week 1's sessions of a version, by title. */
function sessions(version: ProgramVersion): Map<string, StoredSession> {
	return new Map(version.blocks[0]!.weeks[0]!.sessions.map((s) => [s.title, s]));
}

const titled = (version: ProgramVersion, title: string) => sessions(version).get(title)!;

/** The error a call was refused with (fails the test if it was not refused). */
async function refusal(promise: Promise<unknown>): Promise<unknown> {
	const error = await promise.then(
		() => null,
		(err: unknown) => err
	);
	if (!error) throw new Error('expected the call to be refused');
	return error;
}

/** The field errors a call was refused with (fails the test if it was refused otherwise). */
async function fieldErrors(promise: Promise<unknown>): Promise<Record<string, string>> {
	const error = await refusal(promise);
	if (!(error instanceof TrainingInputError)) throw error;
	return error.errors;
}

async function versionCount(db: Executor, owner: string) {
	return (await getVersionHistory(owner, {}, { db }))!.versions.length;
}

// ---- moving ---------------------------------------------------------------------------------

describe('moveSession', () => {
	it('moves Lower A from Monday to Wednesday as version 2, with the reason, leaving version 1 as it was', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const programId = await store(db, owner);
			const v1 = await versionOf(db, owner, programId, 1);
			const lower = titled(v1, 'Lower A');

			const moved = await moveSession(
				owner,
				{
					sessionLineage: lower.lineage,
					toDate: WED,
					timeOfDay: 'evening',
					reason: 'Work trip on Monday'
				},
				{ version: 1, today: MON },
				{ db }
			);
			expect(moved).toMatchObject({ programId, number: 2, warnings: [] });

			const v2 = await versionOf(db, owner, programId, 2);
			const copy = titled(v2, 'Lower A');
			expect(copy).toMatchObject({
				lineage: lower.lineage,
				date: WED,
				timeOfDay: 'evening',
				orderInDay: 1,
				status: 'moved',
				movedFrom: MON
			});
			expect(copy.id).not.toBe(lower.id);
			// Everything else in the week is as it was, and week 2 is shared, not copied.
			for (const [title, session] of sessions(v1)) {
				if (title !== 'Lower A') expect(titled(v2, title)).toMatchObject({ date: session.date });
			}
			expect(v2.blocks[0]!.weeks[1]!.id).toBe(v1.blocks[0]!.weeks[1]!.id);
			// Version 1 still reads the same, row for row.
			expect(await versionOf(db, owner, programId, 1)).toEqual({
				...v1,
				version: { ...v1.version, current: false }
			});

			expect(v2.decisions).toEqual([
				expect.objectContaining({
					kind: 'session_moved',
					ruleKey: null,
					summary: 'Moved Lower A from Mon to Wed',
					why: 'You moved Lower A from Mon to Wed. Work trip on Monday.',
					decidedBy: 'owner',
					affected: [lower.lineage]
				})
			]);
			const history = await getVersionHistory(owner, {}, { db });
			expect(history!.versions[0]).toMatchObject({
				number: 2,
				createdBy: 'owner',
				summary: 'Moved Lower A from Mon to Wed',
				current: true,
				decisions: [{ affected: [{ lineage: lower.lineage, title: 'Lower A', date: WED }] }]
			});
		});
	});

	it("with no reason, the 'why' says who moved it and that no reason was given", async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const programId = await store(db, owner);
			const lower = titled(await versionOf(db, owner, programId, 1), 'Lower A');
			const at = (version: number) => ({ version, today: MON });

			await moveSession(owner, { sessionLineage: lower.lineage, toDate: WED }, at(1), { db });
			// A blank reason is no reason, and the coach (M5) is named as the one who decided.
			await moveSession(
				owner,
				{ sessionLineage: lower.lineage, toDate: THU, reason: '   ' },
				at(2),
				{ db, source: 'coach' }
			);

			const v2 = await versionOf(db, owner, programId, 2);
			expect(v2.decisions[0]!.why).toBe('You moved Lower A from Mon to Wed. No reason given.');
			const v3 = await versionOf(db, owner, programId, 3);
			expect(v3.version.createdBy).toBe('coach');
			expect(v3.decisions[0]).toMatchObject({
				summary: 'Moved Lower A from Wed to Thu',
				why: 'The coach moved Lower A from Wed to Thu. No reason given.',
				decidedBy: 'coach'
			});
		});
	});

	it('keeps moved_from from the first move, takes its place by time of day, and is planned again back on its day', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const programId = await store(db, owner);
			const v1 = await versionOf(db, owner, programId, 1);
			const lower = titled(v1, 'Lower A');
			const easy = titled(v1, 'Easy run');
			const at = (version: number) => ({ version, today: MON });

			// Wednesday, then Thursday morning, after Upper A, which is also in the morning.
			await moveSession(owner, { sessionLineage: lower.lineage, toDate: WED }, at(1), { db });
			await moveSession(owner, { sessionLineage: lower.lineage, toDate: THU }, at(2), { db });
			const v3 = await versionOf(db, owner, programId, 3);
			expect(titled(v3, 'Lower A')).toMatchObject({ date: THU, orderInDay: 2, movedFrom: MON });
			expect(titled(v3, 'Upper A')).toMatchObject({ date: THU, orderInDay: 1 });

			// A morning run goes before Saturday's evening sparring, which becomes the day's second.
			await moveSession(owner, { sessionLineage: easy.lineage, toDate: SAT }, at(3), { db });
			const v4 = await versionOf(db, owner, programId, 4);
			expect(titled(v4, 'Easy run')).toMatchObject({ date: SAT, orderInDay: 1, status: 'moved' });
			expect(titled(v4, 'Sparring')).toMatchObject({ date: SAT, orderInDay: 2, status: 'planned' });

			// Back on the day it was planned for, it is no longer a moved session.
			await moveSession(owner, { sessionLineage: lower.lineage, toDate: MON }, at(4), { db });
			const v5 = await versionOf(db, owner, programId, 5);
			expect(titled(v5, 'Lower A')).toMatchObject({
				date: MON,
				orderInDay: 1,
				status: 'planned',
				movedFrom: null
			});
			expect(titled(v5, 'Easy run')).toMatchObject({ date: SAT, movedFrom: TUE });
		});
	});

	it('moves heavy lower body to the day before sparring, returning and recording the warnings', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const programId = await store(db, owner);
			const lower = titled(await versionOf(db, owner, programId, 1), 'Lower A');
			const move = { sessionLineage: lower.lineage, toDate: FRI };
			const at = { version: 1, today: MON };
			// Saturday's sparring then Sunday's long run, back to back, was already in version 1,
			// so only what the move itself breaks is reported.
			const warnings = [
				{
					rule: 'heavy_lower_before_hard',
					severity: 'avoid',
					days: [FRI, SAT],
					message:
						'Heavy lower body the day before hard Muay Thai: Lower A on Friday, then Sparring on Saturday.'
				},
				{
					rule: 'hard_days_apart',
					severity: 'prefer',
					days: [FRI, SAT],
					message:
						'Hard days back to back, though the week has room to keep them apart: Lower A on Friday, then Sparring on Saturday.'
				}
			];

			// The sheet asks first: the same warnings, and nothing is written.
			expect(await checkMove(owner, move, at, { db })).toEqual(warnings);
			expect(await versionCount(db, owner)).toBe(1);

			const moved = await moveSession(owner, move, at, { db });
			expect(moved).toMatchObject({ number: 2, warnings });
			const v2 = await versionOf(db, owner, programId, 2);
			expect(titled(v2, 'Lower A')).toMatchObject({ date: FRI, status: 'moved' });
			expect(v2.decisions[0]!.why).toBe(
				`You moved Lower A from Mon to Fri. No reason given. ${warnings[0]!.message} ${warnings[1]!.message}`
			);
			expect(v2.decisions[0]!.evidence).toEqual({ from: MON, to: FRI, warnings: 2 });
		});
	});

	it('refuses the move when BLOCKS_EDIT makes a broken rule a block', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const programId = await store(db, owner);
			const lower = titled(await versionOf(db, owner, programId, 1), 'Lower A');
			const blocks = BLOCKS_EDIT as Record<Severity, boolean>;
			blocks.avoid = true;
			try {
				expect(
					await fieldErrors(
						moveSession(
							owner,
							{ sessionLineage: lower.lineage, toDate: FRI },
							{ version: 1, today: MON },
							{ db }
						)
					)
				).toEqual({
					toDate:
						'Heavy lower body the day before hard Muay Thai: Lower A on Friday, then Sparring on Saturday.'
				});
				// A 'prefer' rule still only warns: on Sunday, Lower A joins the long run right after
				// Saturday's sparring.
				const moved = await moveSession(
					owner,
					{ sessionLineage: lower.lineage, toDate: SUN },
					{ version: 1, today: MON },
					{ db }
				);
				expect(moved).toMatchObject({
					number: 2,
					warnings: [
						{
							rule: 'hard_days_apart',
							severity: 'prefer',
							days: [SAT, SUN],
							message:
								'Hard days back to back, though the week has room to keep them apart: Sparring on Saturday, then Long run and Lower A on Sunday.'
						}
					]
				});
			} finally {
				blocks.avoid = false;
			}
			expect(await versionCount(db, owner)).toBe(2);
		});
	});

	it('refuses a destination outside the week or before today, a session before today, and a stale version', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const programId = await store(db, owner);
			const v1 = await versionOf(db, owner, programId, 1);
			const lower = titled(v1, 'Lower A');
			const mobile = titled(v1, 'Mobility');
			const move = (lineage: string, toDate: string, today: string, version = 1) =>
				moveSession(owner, { sessionLineage: lineage, toDate }, { version, today }, { db });

			// Next Monday is in the program, but not in this session's week.
			expect(await fieldErrors(move(lower.lineage, day(7), MON))).toEqual({
				toDate: 'Pick a day in its own week'
			});
			expect(await fieldErrors(move(lower.lineage, day(-1), MON))).toEqual({
				toDate: 'Pick a day in its own week'
			});
			// Today is Wednesday: Friday's mobility cannot go back to Tuesday.
			expect(await fieldErrors(move(mobile.lineage, TUE, WED))).toEqual({
				toDate: 'That day has passed'
			});
			// Monday's Lower A has passed, wherever it would go.
			expect(await fieldErrors(move(lower.lineage, THU, WED))).toEqual({
				sessionLineage: 'This session has passed'
			});
			expect(await fieldErrors(move(lower.lineage, MON, MON))).toEqual({
				toDate: 'It is already on that day'
			});
			expect(
				await fieldErrors(
					moveSession(
						owner,
						{ sessionLineage: 'not-a-lineage', toDate: 'next week' },
						{ version: 1, today: MON },
						{ db }
					)
				)
			).toEqual({ sessionLineage: 'Unknown session', toDate: 'Pick a day' });
			expect(await versionCount(db, owner)).toBe(1);

			// Version 2 is current: an edit made on version 1 is a conflict, and writes nothing.
			await move(lower.lineage, WED, MON);
			const stale = await refusal(move(mobile.lineage, SUN, MON, 1));
			expect(stale).toBeInstanceOf(ProgramConflictError);
			expect((stale as ConflictError).reason).toBe('version');
			// So is the check before saving, and it wins over what version 1 would refuse.
			const preview = { sessionLineage: mobile.lineage, toDate: SUN };
			expect(
				await refusal(checkMove(owner, preview, { version: 1, today: MON }, { db }))
			).toBeInstanceOf(ProgramConflictError);
			expect(await refusal(move(lower.lineage, MON, MON, 1))).toBeInstanceOf(ProgramConflictError);
			expect(await versionCount(db, owner)).toBe(2);
			expect(await refusal(move(lower.lineage, THU, MON, 7))).toBeInstanceOf(TrainingNotFoundError);
			expect(await refusal(move(crypto.randomUUID(), THU, MON, 2))).toBeInstanceOf(
				TrainingNotFoundError
			);
		});
	});

	it('refuses a completed session, for a move and a skip', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const programId = await store(db, owner);
			const upper = titled(await versionOf(db, owner, programId, 1), 'Upper A');
			// Logged early, on Monday: completion goes by lineage, whatever the date.
			await db.insert(workouts).values({
				ownerId: owner,
				clientId: crypto.randomUUID(),
				kind: 'strength',
				discipline: 'strength',
				sessionType: 'strength',
				title: 'Upper A',
				plannedSessionId: upper.id,
				plannedLineageId: upper.lineage,
				programId,
				status: 'completed',
				startedAt: new Date(`${MON}T07:00:00Z`),
				finishedAt: new Date(`${MON}T08:00:00Z`)
			});
			const at = { version: 1, today: MON };

			const done = { sessionLineage: 'This session is done' };
			expect(
				await fieldErrors(
					moveSession(owner, { sessionLineage: upper.lineage, toDate: FRI }, at, { db })
				)
			).toEqual(done);
			expect(
				await fieldErrors(skipSession(owner, { sessionLineage: upper.lineage }, at, { db }))
			).toEqual(done);
			expect(await getMoveTargets(owner, upper.lineage, MON, { db })).toEqual([]);
			expect(await versionCount(db, owner)).toBe(1);
		});
	});
});

// ---- the days a move can reach --------------------------------------------------------------

describe('getMoveTargets', () => {
	it("lists the session's week from today on, its own day left out, each with what is planned there", async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const programId = await store(db, owner);
			const v1 = await versionOf(db, owner, programId, 1);
			const longRun = titled(v1, 'Long run');
			const lower = titled(v1, 'Lower A');

			// Sunday is the last day of its week: on Sunday, no day is left.
			expect(await getMoveTargets(owner, longRun.lineage, SUN, { db })).toEqual([]);
			expect(await getMoveTargets(owner, longRun.lineage, WED, { db })).toEqual([
				{ date: WED, planned: 'Rest day' },
				{ date: THU, planned: 'Upper A' },
				{ date: FRI, planned: 'Mobility' },
				{ date: SAT, planned: 'Sparring' }
			]);
			expect(
				(await getMoveTargets(owner, lower.lineage, MON, { db })).map((target) => target.date)
			).toEqual([TUE, WED, THU, FRI, SAT, SUN]);
			// A session that has passed can go nowhere.
			expect(await getMoveTargets(owner, lower.lineage, TUE, { db })).toEqual([]);

			await expect(getMoveTargets(owner, 'not-a-lineage', MON, { db })).rejects.toBeInstanceOf(
				TrainingNotFoundError
			);
			await expect(getMoveTargets(owner, longRun.lineage, 'Sunday', { db })).rejects.toThrow(
				TrainingInputError
			);
		});
	});

	it('leaves out a day that already holds four sessions, and fits a long why with its warnings', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			// The longest titles a plan allows: 60 characters.
			const long = (title: string) => title.padEnd(60, '.');
			const times = ['early_morning', 'morning', 'afternoon', 'evening'];
			const programId = await store(db, owner, [
				week(MONDAY, [
					lowerBody(THU, long('Lower A')),
					...times.map((timeOfDay, n) =>
						sparring(SAT, { title: long(`Sparring ${n + 1}`), timeOfDay, orderInDay: n + 1 })
					)
				])
			]);
			const lower = titled(await versionOf(db, owner, programId, 1), long('Lower A'));
			const at = { version: 1, today: MON };

			expect(
				(await getMoveTargets(owner, lower.lineage, MON, { db })).map((target) => target.date)
			).toEqual([MON, TUE, WED, FRI, SUN]);
			expect(
				await fieldErrors(
					moveSession(owner, { sessionLineage: lower.lineage, toDate: SAT }, at, { db })
				)
			).toEqual({ toDate: 'That day already has four sessions' });

			// Friday comes before every sparring session: four warnings and one for the hard days.
			const reason = 'Travelling for work '.repeat(10).trim();
			const moved = await moveSession(
				owner,
				{ sessionLineage: lower.lineage, toDate: FRI, reason },
				at,
				{ db }
			);
			expect(moved.warnings.map((w) => w.rule)).toEqual([
				'heavy_lower_before_hard',
				'heavy_lower_before_hard',
				'heavy_lower_before_hard',
				'heavy_lower_before_hard',
				'hard_days_apart'
			]);
			const { why } = (await versionOf(db, owner, programId, 2)).decisions[0]!;
			expect(why.length).toBeLessThanOrEqual(1000);
			expect(why).toBe(
				[
					`You moved ${long('Lower A')} from Thu to Fri. ${reason}.`,
					...moved.warnings.slice(0, 3).map((w) => w.message),
					'And 2 more warnings.'
				].join(' ')
			);
		});
	});
});

// ---- skipping -------------------------------------------------------------------------------

describe('skipSession', () => {
	it('skips a session as a new version with its decision; skipping it again is a field error', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const programId = await store(db, owner);
			const v1 = await versionOf(db, owner, programId, 1);
			const upper = titled(v1, 'Upper A');

			const skipped = await skipSession(
				owner,
				{ sessionLineage: upper.lineage, reason: 'Shoulder is sore' },
				{ version: 1, today: MON },
				{ db }
			);
			expect(skipped).toMatchObject({ programId, number: 2 });
			const v2 = await versionOf(db, owner, programId, 2);
			expect(titled(v2, 'Upper A')).toMatchObject({
				lineage: upper.lineage,
				date: THU,
				status: 'skipped',
				movedFrom: null
			});
			expect(titled(await versionOf(db, owner, programId, 1), 'Upper A').status).toBe('planned');
			expect(v2.decisions).toEqual([
				expect.objectContaining({
					kind: 'session_skipped',
					summary: 'Skipped Upper A on Thu',
					why: 'You skipped Upper A on Thu. Shoulder is sore.',
					decidedBy: 'owner',
					affected: [upper.lineage],
					evidence: { date: THU }
				})
			]);

			const at = { version: 2, today: MON };
			const already = { sessionLineage: 'This session is skipped' };
			expect(
				await fieldErrors(skipSession(owner, { sessionLineage: upper.lineage }, at, { db }))
			).toEqual(already);
			expect(
				await fieldErrors(
					moveSession(owner, { sessionLineage: upper.lineage, toDate: FRI }, at, { db })
				)
			).toEqual(already);
			expect(await getMoveTargets(owner, upper.lineage, MON, { db })).toEqual([]);
			// A skipped session is not what its day holds any more.
			const lower = titled(v2, 'Lower A');
			expect(
				(await getMoveTargets(owner, lower.lineage, MON, { db })).find((t) => t.date === THU)
			).toEqual({ date: THU, planned: 'Rest day' });

			// With no reason, the why says so; a session that has passed cannot be skipped.
			await skipSession(owner, { sessionLineage: lower.lineage }, at, { db });
			const v3 = await versionOf(db, owner, programId, 3);
			expect(v3.decisions[0]!.why).toBe('You skipped Lower A on Mon. No reason given.');
			const easy = titled(v3, 'Easy run');
			expect(
				await fieldErrors(
					skipSession(owner, { sessionLineage: easy.lineage }, { version: 3, today: WED }, { db })
				)
			).toEqual({ sessionLineage: 'This session has passed' });
			expect(await versionCount(db, owner)).toBe(3);
		});
	});
});
