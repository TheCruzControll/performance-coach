/**
 * Several edits as one version on real Postgres (services/programs/batch.ts): what accepting the
 * coach's program_adjustment writes. Three ops give one version with three coach decisions, each
 * affected week copied once and every other week shared; a stale base is a conflict; an invalid
 * op fails the whole batch at its index; a never-again swap records the dislike as the coach's.
 *
 * The plan runs Monday 9 to Sunday 29 November 2026, three weeks alike, and each call says which
 * day is today.
 */
import { asc, eq, inArray, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { addDays } from '../../../src/lib/domain/calendar';
import type {
	PlannedExercisePlan,
	ProgramPlan,
	SessionPlan,
	SetPrescription,
	WeekPlan
} from '../../../src/lib/domain/training/types';
import type { Executor } from '../../../src/lib/server/db';
import { programmingDecisions, programWeeks } from '../../../src/lib/server/db/schema/programs';
import { findErrorsByRequestId } from '../../../src/lib/server/services/errors';
import { resolveKeys } from '../../../src/lib/server/services/exercises/index';
import {
	createContextCache,
	readContext,
	type ContextCache,
	type ContextReader
} from '../../../src/lib/server/services/periodisation/context';
import { getAthleteProfile } from '../../../src/lib/server/services/profile/index';
import {
	applyProgramEdits,
	OPS_OVERLAP,
	type ProgramEditBatch
} from '../../../src/lib/server/services/programs/batch';
import {
	adjustPrescription,
	checkMove,
	createProgramFromPlan,
	getProgramVersion,
	getVersionHistory,
	skipSession,
	type ProgramVersion,
	type StoredSession
} from '../../../src/lib/server/services/programs/index';
import { listExercisePreferences } from '../../../src/lib/server/services/training/preferences';
import {
	ProgramConflictError,
	TrainingInputError
} from '../../../src/lib/server/services/training/shared';
import {
	FIXTURE_COMMITMENT,
	FIXTURE_GOAL
} from '../../../src/lib/server/test-support/program-fixtures';
import { takeOverlaps } from '../one-query-per-client';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const MONDAY = '2026-11-09';
const day = (n: number) => addDays(MONDAY, n);
const [MON, TUE, WED] = [day(0), day(1), day(2)];

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

const backSquat = (): PlannedExercisePlan => ({
	exercise: { key: 'back_squat' },
	baselineLift: 'back_squat',
	superset: null,
	substitutedFrom: null,
	substitutionReason: null,
	instructions: null,
	notes: null,
	sets: [set({ role: 'top', sets: 1, targetRpe: 8 }), set({ role: 'back_off' })]
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

const strength = (date: string, title: string): SessionPlan => ({
	...base(date, title, 45, 8),
	kind: 'strength',
	type: 'strength',
	discipline: 'strength',
	intensity: 'hard',
	exercises: [backSquat()]
});

const easyRun = (date: string): SessionPlan => ({
	...base(date, 'Easy run', 40, 4),
	kind: 'run',
	type: 'easy_run',
	discipline: 'running',
	intensity: 'easy',
	segments: [
		{
			kind: 'steady',
			repeatGroup: null,
			repeats: null,
			distanceMetres: null,
			durationSeconds: 1200,
			paceMinSecondsPerKm: null,
			paceMaxSecondsPerKm: null,
			hrZone: 2,
			targetRpe: null
		},
		{
			kind: 'steady',
			repeatGroup: null,
			repeats: null,
			distanceMetres: null,
			durationSeconds: 1200,
			paceMinSecondsPerKm: 300,
			paceMaxSecondsPerKm: 360,
			hrZone: 2,
			targetRpe: null
		}
	]
});

const muayThai = (date: string): SessionPlan => ({
	...base(date, 'Muay Thai', 90, 8),
	timeOfDay: 'evening',
	kind: 'other',
	type: 'muay_thai',
	discipline: 'muay_thai',
	intensity: 'hard',
	source: 'commitment',
	commitmentRef: FIXTURE_COMMITMENT,
	details: { kind: 'pad_work', durationMinutes: 90, targetRpe: 8, metrics: [], notes: null }
});

/** Lower A on Monday, an easy run on Tuesday, Lower B on Thursday, Muay Thai on Saturday. */
const week = (monday: string): WeekPlan => {
	const d = (n: number) => addDays(monday, n);
	return {
		kind: 'baseline',
		startsOn: monday,
		endsOn: d(6),
		targets: { rpeCap: 8, volumeFactor: 1, loadStep: 0, runVolumeFactor: 1 },
		sessions: [strength(d(0), 'Lower A'), easyRun(d(1)), strength(d(3), 'Lower B'), muayThai(d(5))]
	};
};

const plan = (): ProgramPlan => ({
	title: 'Batch fixture',
	startsOn: MONDAY,
	firstPlannedDay: MONDAY,
	blocks: [
		{
			phase: 'baseline',
			name: 'Baseline',
			startsOn: MONDAY,
			endsOn: day(20),
			outline: false,
			goalRefs: [FIXTURE_GOAL],
			progression: {},
			weeks: [week(MONDAY), week(day(7)), week(day(14))]
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
});

async function store(db: Executor, owner: string) {
	const created = await createProgramFromPlan(owner, plan(), { source: 'rules' }, { db });
	return created.programId;
}

const versionOf = (db: Executor, owner: string, programId: string, n: number) =>
	getProgramVersion(owner, programId, n, { db });

const titled = (version: ProgramVersion, w: number, title: string): StoredSession =>
	version.blocks[0]!.weeks[w]!.sessions.find((s) => s.title === title)!;

function squatOf(session: StoredSession) {
	if (session.kind !== 'strength') throw new Error(`${session.title} is not a strength session`);
	return session.exercises[0]!;
}

const weekIds = (v: ProgramVersion) => v.blocks[0]!.weeks.map((w) => w.id);

/** Every week row the program has, across its versions. */
async function weekRows(db: Executor, v: ProgramVersion) {
	return db
		.select({ id: programWeeks.id })
		.from(programWeeks)
		.where(
			inArray(
				programWeeks.blockId,
				v.blocks.map((b) => b.id)
			)
		);
}

async function versionNumbers(db: Executor, owner: string) {
	const history = await getVersionHistory(owner, {}, { db });
	return history!.versions.map((v) => v.number);
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => new Error('expected a refusal'),
		(err: unknown) => err
	);
}

async function fieldErrors(promise: Promise<unknown>): Promise<Record<string, string>> {
	const error = await refusal(promise);
	if (!(error instanceof TrainingInputError)) throw error;
	return error.errors;
}

const RATIONALE = 'Your sleep has been short this week, so the hard days are spread out.';

const batchOf = (ops: unknown[], over: Partial<ProgramEditBatch> = {}): ProgramEditBatch => ({
	baseVersion: 1,
	today: MON,
	ops,
	title: 'Spread out the hard days',
	rationale: RATIONALE,
	evidence: { proposalId: 'f1a7e000-0000-4000-8000-0000000000aa' },
	...over
});

// ---- tests ----------------------------------------------------------------------------------

describe('applyProgramEdits', () => {
	it('writes three ops as one version with three coach decisions, copying each affected week once', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const programId = await store(db, owner);
			const v1 = await versionOf(db, owner, programId, 1);
			const run = titled(v1, 0, 'Easy run');
			const lowerA = titled(v1, 0, 'Lower A');
			const fight = titled(v1, 1, 'Muay Thai');

			const revised = await applyProgramEdits(
				owner,
				batchOf([
					{ op: 'move', sessionLineage: run.lineage, toDate: WED },
					{
						op: 'adjust_set',
						sessionLineage: lowerA.lineage,
						plannedExerciseLineage: squatOf(lowerA).lineage,
						position: 2,
						sets: 4
					},
					{ op: 'adjust_details', sessionLineage: fight.lineage, durationMinutes: 60 }
				]),
				{ db }
			);
			expect(revised).toMatchObject({ programId, number: 2 });
			expect(await versionNumbers(db, owner)).toEqual([2, 1]);

			const v2 = await versionOf(db, owner, programId, 2);
			expect(v2.version).toMatchObject({
				summary: 'Spread out the hard days',
				createdBy: 'coach',
				current: true
			});
			// Every op landed.
			expect(titled(v2, 0, 'Easy run')).toMatchObject({
				lineage: run.lineage,
				date: WED,
				status: 'moved',
				movedFrom: TUE
			});
			expect(squatOf(titled(v2, 0, 'Lower A')).sets[1]).toMatchObject({ sets: 4 });
			const fight2 = titled(v2, 1, 'Muay Thai');
			expect(fight2.kind === 'other' && fight2.details.durationMinutes).toBe(60);

			// Weeks 1 and 2 are copied, week 1 once for its two ops; week 3 is shared, rows and all.
			const [w1, w2, w3] = weekIds(v1);
			expect(weekIds(v2)).not.toContain(w1);
			expect(weekIds(v2)).not.toContain(w2);
			expect(weekIds(v2)[2]).toBe(w3);
			expect(v2.blocks[0]!.weeks[2]).toEqual(v1.blocks[0]!.weeks[2]);
			expect(await weekRows(db, v2)).toHaveLength(3 + 2);
			expect(await versionOf(db, owner, programId, 1)).toEqual({
				...v1,
				version: { ...v1.version, current: false }
			});

			// One decision per op, in order, each the coach's with the proposal's rationale.
			expect(v2.decisions).toEqual([
				expect.objectContaining({
					kind: 'session_moved',
					summary: 'Moved Easy run from Tue to Wed',
					affected: [run.lineage]
				}),
				expect.objectContaining({
					kind: 'prescription_adjusted',
					summary: 'Adjusted Back squat, back-off',
					affected: [lowerA.lineage, squatOf(lowerA).lineage]
				}),
				expect.objectContaining({
					kind: 'prescription_adjusted',
					summary: 'Adjusted Muay Thai',
					affected: [fight.lineage]
				})
			]);
			for (const decision of v2.decisions) {
				expect(decision).toMatchObject({ why: RATIONALE, decidedBy: 'coach' });
			}
			const evidence = await db
				.select({ evidence: programmingDecisions.evidence })
				.from(programmingDecisions)
				.where(eq(programmingDecisions.versionId, v2.version.id))
				.orderBy(asc(programmingDecisions.id));
			expect(evidence.map((d) => d.evidence)).toEqual([
				{ from: TUE, to: WED, warnings: 0, proposalId: 'f1a7e000-0000-4000-8000-0000000000aa' },
				{ proposalId: 'f1a7e000-0000-4000-8000-0000000000aa' },
				{ proposalId: 'f1a7e000-0000-4000-8000-0000000000aa' }
			]);
		});
	});

	it('refuses a stale base with a conflict, writing nothing', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const programId = await store(db, owner);
			const v1 = await versionOf(db, owner, programId, 1);
			const [goblet] = [(await resolveKeys(['goblet_squat'], { db })).get('goblet_squat')!.id];
			// The owner edits after the coach drafted on version 1.
			await skipSession(
				owner,
				{ sessionLineage: titled(v1, 0, 'Muay Thai').lineage },
				{ version: 1, today: MON },
				{ db }
			);

			const lowerB = titled(v1, 0, 'Lower B');
			const error = await refusal(
				applyProgramEdits(
					owner,
					batchOf([
						{
							op: 'swap',
							sessionLineage: lowerB.lineage,
							plannedExerciseLineage: squatOf(lowerB).lineage,
							toExerciseId: goblet,
							scope: 'never_again'
						}
					]),
					{ db }
				)
			);
			expect(error).toBeInstanceOf(ProgramConflictError);
			expect(await versionNumbers(db, owner)).toEqual([2, 1]);
			expect(await listExercisePreferences(owner, { db })).toEqual([]);
		});
	});

	it('fails the whole batch at the index of an invalid or refused op', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const programId = await store(db, owner);
			const v1 = await versionOf(db, owner, programId, 1);
			const run = titled(v1, 0, 'Easy run');
			const lowerA2 = titled(v1, 1, 'Lower A');
			const lowerB = titled(v1, 0, 'Lower B');
			const valid = { op: 'skip', sessionLineage: titled(v1, 1, 'Muay Thai').lineage };
			const at = { today: WED };

			// A day that has passed, as moveSession refuses it, at ops.1.
			expect(
				await fieldErrors(
					applyProgramEdits(
						owner,
						batchOf([valid, { op: 'move', sessionLineage: lowerB.lineage, toDate: TUE }], at),
						{ db }
					)
				)
			).toEqual({ 'ops.1.toDate': 'That day has passed' });
			// What M3's schema refuses, at ops.2.
			const errors = await fieldErrors(
				applyProgramEdits(
					owner,
					batchOf(
						[
							valid,
							{ op: 'skip', sessionLineage: lowerB.lineage },
							{
								op: 'adjust_set',
								sessionLineage: lowerA2.lineage,
								plannedExerciseLineage: squatOf(lowerA2).lineage,
								position: 1,
								sets: 0
							}
						],
						at
					),
					{ db }
				)
			);
			expect(Object.keys(errors)).toEqual(['ops.2.sets']);
			// A session the program does not have.
			expect(
				await fieldErrors(
					applyProgramEdits(
						owner,
						batchOf([valid, { op: 'skip', sessionLineage: crypto.randomUUID() }], at),
						{ db }
					)
				)
			).toEqual({ 'ops.1': 'This planned session is not in the program' });
			// Two ops on the same field of the same session, and two moves to one day.
			expect(
				await fieldErrors(
					applyProgramEdits(
						owner,
						batchOf([
							{ op: 'move', sessionLineage: run.lineage, toDate: WED },
							{ op: 'skip', sessionLineage: run.lineage }
						]),
						{ db }
					)
				)
			).toEqual({ 'ops.1': OPS_OVERLAP });
			expect(
				await fieldErrors(
					applyProgramEdits(
						owner,
						batchOf([
							{ op: 'move', sessionLineage: run.lineage, toDate: WED },
							{ op: 'move', sessionLineage: lowerB.lineage, toDate: WED }
						]),
						{ db }
					)
				)
			).toEqual({ 'ops.1': OPS_OVERLAP });
			// No ops at all.
			expect(await fieldErrors(applyProgramEdits(owner, batchOf([]), { db }))).toEqual({
				ops: 'Propose at least one change'
			});

			expect(await versionNumbers(db, owner)).toEqual([1]);
		});
	});

	it('composes adjustments of one session, its estimate worked out from all of them', async () => {
		const setOps = (lowerA: StoredSession) => {
			const squat = {
				sessionLineage: lowerA.lineage,
				plannedExerciseLineage: squatOf(lowerA).lineage
			};
			return [
				{ ...squat, position: 1, sets: 3 },
				{ ...squat, position: 2, sets: 5 }
			];
		};
		// The set edits one after the other, as the owner would make them.
		const sequential = await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const programId = await store(db, owner);
			const lowerA = titled(await versionOf(db, owner, programId, 1), 0, 'Lower A');
			for (const [k, input] of setOps(lowerA).entries()) {
				await adjustPrescription(owner, input, { version: k + 1, today: MON }, { db });
			}
			return titled(await versionOf(db, owner, programId, 3), 0, 'Lower A');
		});

		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const programId = await store(db, owner);
			const v1 = await versionOf(db, owner, programId, 1);
			const run = { op: 'adjust_run_segment', sessionLineage: titled(v1, 0, 'Easy run').lineage };
			await applyProgramEdits(
				owner,
				batchOf([
					{ ...run, position: 1, durationSeconds: 1800 },
					{ ...run, position: 2, durationSeconds: 2400 },
					...setOps(titled(v1, 0, 'Lower A')).map((o) => ({ op: 'adjust_set', ...o }))
				]),
				{ db }
			);
			const v2 = await versionOf(db, owner, programId, 2);
			// 30 + 40 minutes of segments at RPE 4.
			expect(titled(v2, 0, 'Easy run')).toMatchObject({ estMinutes: 70, estLoad: 70 * 4 });
			const lowerA = titled(v2, 0, 'Lower A');
			expect(squatOf(lowerA).sets.map((s) => s.sets)).toEqual([3, 5]);
			expect(lowerA).toMatchObject({
				estMinutes: sequential.estMinutes,
				estLoad: sequential.estLoad
			});
		});
	});

	it('refuses at its op a change that makes a composed row invalid, writing nothing', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const programId = await store(db, owner);
			const run = titled(await versionOf(db, owner, programId, 1), 0, 'Easy run');
			const segment = { op: 'adjust_run_segment', sessionLineage: run.lineage, position: 2 };

			// Each is valid on 5:00–6:00 /km; together they reverse the range.
			const errors = await fieldErrors(
				applyProgramEdits(
					owner,
					batchOf([
						{ ...segment, paceMinSecondsPerKm: 350 },
						{ ...segment, paceMaxSecondsPerKm: 330 }
					]),
					{ db }
				)
			);
			expect(Object.keys(errors).length).toBeGreaterThan(0);
			for (const key of Object.keys(errors)) expect(key).toMatch(/^ops\.1\.pace/);
			expect(await versionNumbers(db, owner)).toEqual([1]);
		});
	});

	it('never again: records the dislike as the coach’s and swaps from today, in the same version as the other ops', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const programId = await store(db, owner);
			const v1 = await versionOf(db, owner, programId, 1);
			const found = await resolveKeys(['goblet_squat', 'back_squat'], { db });
			const [goblet, squat] = [found.get('goblet_squat')!.id, found.get('back_squat')!.id];
			const lowerB = titled(v1, 0, 'Lower B');
			const run2 = titled(v1, 1, 'Easy run');

			const revised = await applyProgramEdits(
				owner,
				batchOf(
					[
						{
							op: 'swap',
							sessionLineage: lowerB.lineage,
							plannedExerciseLineage: squatOf(lowerB).lineage,
							toExerciseId: goblet,
							scope: 'never_again',
							reason: 'My lower back flares up'
						},
						{ op: 'skip', sessionLineage: run2.lineage }
					],
					{ today: WED }
				),
				{ db }
			);
			expect(revised.number).toBe(2);

			expect(await listExercisePreferences(owner, { db })).toEqual([
				expect.objectContaining({
					exerciseId: squat,
					sentiment: 'dislike',
					reason: 'My lower back flares up',
					source: 'coach'
				})
			]);
			const v2 = await versionOf(db, owner, programId, 2);
			// Thursday's Lower B and both sessions of weeks 2 and 3; Monday's Lower A has passed.
			for (const [w, title] of [
				[0, 'Lower B'],
				[1, 'Lower A'],
				[1, 'Lower B'],
				[2, 'Lower A'],
				[2, 'Lower B']
			] as const) {
				expect(squatOf(titled(v2, w, title))).toMatchObject({
					exercise: { key: 'goblet_squat' },
					substitutedFrom: { key: 'back_squat' },
					substitutionReason: 'dislike'
				});
			}
			expect(squatOf(titled(v2, 0, 'Lower A')).exercise).toEqual({ key: 'back_squat' });
			expect(titled(v2, 1, 'Easy run').status).toBe('skipped');
			// Week 2 is copied once for both ops.
			expect(await weekRows(db, v2)).toHaveLength(3 + 3);
			expect(v2.decisions).toEqual([
				expect.objectContaining({
					kind: 'preference_recorded',
					summary: 'Back squat is never prescribed again',
					why: RATIONALE,
					decidedBy: 'coach'
				}),
				expect.objectContaining({ kind: 'session_skipped', why: RATIONALE, decidedBy: 'coach' })
			]);
		});
	});

	it('records no dislike when a later op fails the batch', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const programId = await store(db, owner);
			const v1 = await versionOf(db, owner, programId, 1);
			const goblet = (await resolveKeys(['goblet_squat'], { db })).get('goblet_squat')!.id;
			const lowerB = titled(v1, 0, 'Lower B');

			const errors = await fieldErrors(
				applyProgramEdits(
					owner,
					batchOf(
						[
							{
								op: 'swap',
								sessionLineage: lowerB.lineage,
								plannedExerciseLineage: squatOf(lowerB).lineage,
								toExerciseId: goblet,
								scope: 'never_again'
							},
							{ op: 'skip', sessionLineage: titled(v1, 0, 'Lower A').lineage }
						],
						{ today: WED }
					),
					{ db }
				)
			);
			expect(errors).toEqual({ 'ops.1.sessionLineage': 'This session has passed' });
			expect(await listExercisePreferences(owner, { db })).toEqual([]);
			expect(await versionNumbers(db, owner)).toEqual([1]);
		});
	});
});

// ---- the moves' context (m7/23 move-evaluation) ---------------------------------------------

describe("applyProgramEdits with M7's context", () => {
	/** Wide enough for real-data reads on a loaded CI runner. */
	const SLOW_OK = 10_000;

	/** An owner whose profile row exists, as it does for anyone with a program. */
	async function ownerWithProfile(db: Executor) {
		const owner = await makeOwner(db);
		await getAthleteProfile(owner, { db });
		return owner;
	}

	/**
	 * Twelve ops: three moves in week 1 (the easy run to Wednesday, Lower B to Friday the day
	 * before Muay Thai, Lower A to Sunday), and nine adjustments across the three weeks.
	 */
	function twelveOps(v1: ProgramVersion) {
		const of = (title: string) => (w: number) => titled(v1, w, title);
		const [run, lowerA, lowerB, fight] = [
			of('Easy run'),
			of('Lower A'),
			of('Lower B'),
			of('Muay Thai')
		];
		const sets = (session: StoredSession) => ({
			op: 'adjust_set',
			sessionLineage: session.lineage,
			plannedExerciseLineage: squatOf(session).lineage,
			position: 2,
			sets: 4
		});
		const later = (w: number) => [
			sets(lowerA(w)),
			sets(lowerB(w)),
			{ op: 'adjust_details', sessionLineage: fight(w).lineage, durationMinutes: 60 },
			{
				op: 'adjust_run_segment',
				sessionLineage: run(w).lineage,
				position: 1,
				durationSeconds: 900
			}
		];
		return [
			{ op: 'move', sessionLineage: run(0).lineage, toDate: WED },
			{ op: 'move', sessionLineage: lowerB(0).lineage, toDate: day(4) },
			{ op: 'move', sessionLineage: lowerA(0).lineage, toDate: day(6) },
			{ op: 'adjust_details', sessionLineage: fight(0).lineage, durationMinutes: 60 },
			...later(1),
			...later(2)
		];
	}

	it('reads the context once for a 12-op batch, and still applies one version', async () => {
		await withRollback(async (db) => {
			const owner = await ownerWithProfile(db);
			const programId = await store(db, owner);
			const v1 = await versionOf(db, owner, programId, 1);
			let reads = 0;
			const contexts = createContextCache(owner, {
				db,
				statementTimeoutMs: SLOW_OK,
				reader: (tx, ownerId, at, deps) => {
					reads += 1;
					return readContext(tx, ownerId, at, deps);
				}
			});

			const ops = twelveOps(v1);
			expect(ops).toHaveLength(12);
			const revised = await applyProgramEdits(owner, batchOf(ops), { db, contexts });
			expect(revised).toMatchObject({ programId, number: 2 });
			expect(await versionNumbers(db, owner)).toEqual([2, 1]);
			expect(reads).toBe(1);
			const v2 = await versionOf(db, owner, programId, 2);
			expect(v2.decisions).toHaveLength(12);
			expect(titled(v2, 0, 'Lower B').date).toBe(day(4));
		});
	});

	it('with the context’s reads stalled inside the caller’s transaction, applies with M3’s warnings and records it', async () => {
		await withRollback(async (db) => {
			const owner = await ownerWithProfile(db);
			const programId = await store(db, owner);
			const v1 = await versionOf(db, owner, programId, 1);
			const requestId = crypto.randomUUID();
			const stall: ContextReader = async (tx) => {
				await tx.execute(sql`select pg_sleep(1)`);
				return null;
			};
			const contexts = createContextCache(owner, {
				db,
				reader: stall,
				origin: { requestId, method: 'POST', path: '/coach', routeId: null, appVersion: 'test' }
			});
			const lowerB = titled(v1, 0, 'Lower B');
			const move = { sessionLineage: lowerB.lineage, toDate: day(4) };
			const none = { get: async () => null } as unknown as ContextCache;
			const m3 = await checkMove(owner, move, { version: 1, today: MON }, { db, contexts: none });
			expect(m3.map((w) => w.rule)).toEqual(['heavy_lower_before_hard', 'hard_days_apart']);

			const revised = await applyProgramEdits(owner, batchOf([{ op: 'move', ...move }]), {
				db,
				contexts
			});
			expect(revised.number).toBe(2);
			expect(takeOverlaps()).toEqual([]);
			const [evidence] = await db
				.select({ evidence: programmingDecisions.evidence })
				.from(programmingDecisions)
				.where(eq(programmingDecisions.versionId, revised.versionId));
			expect(evidence!.evidence).toMatchObject({ warnings: m3.length });
			const errors = await findErrorsByRequestId(requestId, { db });
			expect(errors.map((e) => e.context)).toEqual([
				expect.objectContaining({ part: 'evaluation-context', code: '57014' })
			]);
		});
	});
});
