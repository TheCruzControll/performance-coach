/**
 * Re-plans as M5 proposals on real Postgres (services/periodisation/propose.ts and
 * services/coach/apply/replan.ts):
 * - the lifecycle: proposed with its rows, accepted once as version N + 1 with a replanned
 *   decision (a repeated accept returns the stored result), rejected with nothing changed
 * - staleness at accept: a profile edit (profile_changed), a logged set (still applies, loads
 *   refreshed), a Monday passed (start_passed), a deload proposed Monday and accepted Thursday
 *   (only Thursday to Sunday change) or after its week (sessions_passed), a newer version
 *   (program_changed); every superseded one offers Propose again
 * - a weekly review's deload writes review_applied, so weekChanges names the review
 * - transactions and scope: the same source revises, the same shape is returned; inside a
 *   transaction holding the owner's locks on a pool of one connection; with the context's reader
 *   stalled inside the accept transaction under the one-query guard; a foreign owner; M5's
 *   content guard
 * Today is Wednesday 18 Nov 2026 in Los Angeles (block-end: the block ends Sunday, an outline
 * starts Monday 23 Nov), or Monday 16 Nov for the deloads (week-complete: this week is planned).
 */
import { sql } from 'drizzle-orm';
import type pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { addDays, type IsoDate } from '../../../src/lib/domain/calendar';
import type { ReplanDirective } from '../../../src/lib/domain/training/replan';
import {
	createDatabase,
	createPool,
	getDb,
	workouts,
	type Executor
} from '../../../src/lib/server/db';
import { createCoachProposalsRepository } from '../../../src/lib/server/db/repositories/coach-proposals';
import { createReviewsRepository } from '../../../src/lib/server/db/repositories/reviews';
import { APPLIERS } from '../../../src/lib/server/services/coach/apply';
import { applyReplan } from '../../../src/lib/server/services/coach/apply/replan';
import {
	acceptProposal,
	getProposalView,
	rejectProposal
} from '../../../src/lib/server/services/coach/proposals';
import { CoachNotFoundError } from '../../../src/lib/server/services/coach/shared';
import { findErrorsByRequestId } from '../../../src/lib/server/services/errors';
import { resolveKeys } from '../../../src/lib/server/services/exercises/index';
import type { ContextReader } from '../../../src/lib/server/services/periodisation/context';
import { previewReplan } from '../../../src/lib/server/services/periodisation/preview';
import {
	proposeReplan,
	type ProposeDeps,
	type ReplanRequest
} from '../../../src/lib/server/services/periodisation/propose';
import { createGoal } from '../../../src/lib/server/services/profile';
import {
	getProgramVersion,
	skipSession,
	type ProgramVersion
} from '../../../src/lib/server/services/programs/index';
import { weekChanges } from '../../../src/lib/server/services/programs/week-changes';
import { createWeeklyReview } from '../../../src/lib/server/services/reviews';
import { finishWorkout, logSet, startWorkout } from '../../../src/lib/server/services/training/log';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import type { ReviewFixtureResult } from '../../../src/lib/server/test-support/analytics-fixtures/reviews';
import { takeOverlaps } from '../one-query-per-client';
import { withCommitted, withRollback } from '../helpers';
import { makeOwner, makeSecondOwner } from '../profile/fixtures';

const TZ = 'America/Los_Angeles';
const WEDNESDAY = '2026-11-18';
const NEXT_MONDAY = '2026-11-23';
const MONDAY = '2026-11-16';
const THURSDAY = '2026-11-19';
const NEXT_TUESDAY = '2026-11-24';
/** Real reads on a loaded CI runner: far above the context's 300 ms default. */
const SLOW_OK = 10_000;

const PRIORITIES: ReplanDirective = { kind: 'priorities', cause: 'reorder' };
const MAINTENANCE: ReplanDirective = { kind: 'block', phase: 'maintenance', weeks: 4 };
const deloadOf = (week: IsoDate, trigger: 'owner' | 'reactive' = 'owner'): ReplanDirective => ({
	...{ kind: 'deload', week, trigger },
	reasons: ['Legs heavy since the weekend']
});

const clock = (day: IsoDate) => () => atLocal(day, '12:00', TZ);

afterEach(() => {
	vi.restoreAllMocks();
});

/** A review fixture seeded on `today`, with deps on that day's clock. */
async function seeded(db: Executor, name: 'block-end' | 'week-complete', today: IsoDate) {
	const owner = await makeOwner(db);
	const now = clock(today);
	const fixture = (await seedAnalyticsFixture(
		owner,
		name,
		{ timeZone: TZ, now: now() },
		{ db }
	)) as unknown as ReviewFixtureResult & { exercises: Record<string, string> };
	const deps: ProposeDeps = { db, now, statementTimeoutMs: SLOW_OK };
	return { owner, programId: fixture.programId!, fixture, deps };
}

/** Propose, failing the test unless a proposal comes back. */
async function propose(
	owner: string,
	request: Omit<ReplanRequest, 'source'> & Partial<Pick<ReplanRequest, 'source'>>,
	deps: ProposeDeps
) {
	const made = await proposeReplan(owner, { source: 'owner', ...request }, deps);
	if (made.status !== 'proposed') throw new Error(`Not proposed: ${JSON.stringify(made)}`);
	return made;
}

async function versionCount(db: Executor, programId: string) {
	const { rows } = await db.execute<{ n: number }>(
		sql`select count(*)::int as n from program_versions where program_id = ${programId}`
	);
	return rows[0]!.n;
}

const sessionsOf = (v: ProgramVersion, monday: IsoDate) =>
	v.blocks.flatMap((b) => b.weeks.filter((w) => w.startsOn === monday)).flatMap((w) => w.sessions);
const squatSets = (blocks: readonly { weeks: readonly { sessions: readonly unknown[] }[] }[]) =>
	blocks
		.flatMap((b) => b.weeks)
		.flatMap(
			(w) =>
				w.sessions as {
					kind: string;
					exercises?: { exercise: object; sets: { reference1rm: number | null }[] }[];
				}[]
		)
		.flatMap((s) => (s.kind === 'strength' ? s.exercises! : []))
		.filter((e) => 'key' in e.exercise && e.exercise.key === 'back_squat')
		.flatMap((e) => e.sets);

/** Three heavy back squats off the plan, logged at `at`. */
async function squatsAt(db: Executor, owner: string, at: Date, weight: number) {
	const squat = (await resolveKeys(['back_squat'], { db })).get('back_squat')!;
	const workoutClientId = crypto.randomUUID();
	await startWorkout(
		owner,
		{
			...{ clientId: workoutClientId, kind: 'strength', discipline: 'strength' },
			...{ sessionType: 'strength', title: 'Extra squats', plannedSessionId: null },
			startedAt: at.toISOString()
		},
		{ db }
	);
	for (const setIndex of [1, 2, 3]) {
		await logSet(
			owner,
			{
				...{ clientMutationId: crypto.randomUUID(), workoutClientId },
				...{ exerciseId: squat.id, plannedExerciseLineageId: null },
				...{ exercisePosition: 1, setIndex, weight, unit: 'kg', reps: 5 },
				...{ missedReps: 0, rpe: 8, seconds: null, metres: null },
				...{ isExtra: false, isSkipped: false, isWarmup: false },
				performedAt: new Date(at.getTime() + setIndex * 300_000).toISOString()
			},
			{ db }
		);
	}
	const finishedAt = new Date(at.getTime() + 3_600_000).toISOString();
	const done = { status: 'completed', finishedAt, durationSeconds: 3600, sessionRpe: 8 };
	await finishWorkout(owner, workoutClientId, done, { db });
}

const PROPOSAL_AND_PROGRAM_TABLES = [
	'coach_proposals',
	'programs',
	'program_versions',
	'program_weeks',
	'planned_sessions',
	'programming_decisions'
];

/** What this transaction has written to the proposal and program tables so far. */
async function writes(db: Executor) {
	const { rows } = await db.execute<{ table: string; ins: number; upd: number; del: number }>(
		sql`select relname as table, n_tup_ins::int as ins, n_tup_upd::int as upd, n_tup_del::int as del
			from pg_stat_xact_user_tables
			where relname in ${sql.raw(`('${PROPOSAL_AND_PROGRAM_TABLES.join("','")}')`)}`
	);
	return Object.fromEntries(rows.map((r) => [r.table, r]));
}

describe('the lifecycle', () => {
	it('proposes with rows, applies once as version 2 with a replanned decision, and repeats as stored', async () => {
		await withRollback(async (db) => {
			const { owner, programId, deps } = await seeded(db, 'block-end', WEDNESDAY);
			const shown = await previewReplan(
				owner,
				{ today: WEDNESDAY, directive: PRIORITIES },
				{ db, statementTimeoutMs: SLOW_OK }
			);
			if ('refusal' in shown) throw new Error(shown.why);
			const { proposal, duplicate } = await propose(
				owner,
				{ today: WEDNESDAY, directive: PRIORITIES },
				deps
			);
			expect(duplicate).toBe(false);
			expect(proposal).toMatchObject({ kind: 'replan', status: 'proposed', origin: null });
			expect(proposal.rows.length).toBe(shown.weeks.flatMap((w) => w.rows).length);
			expect(proposal.rows[0]!.label.startsWith(`${shown.weeks[0]!.label} · `)).toBe(true);
			expect(proposal.summaryLines).toEqual(shown.summaryLines);
			expect(proposal.impact).toEqual(shown.impact);

			const accepted = await acceptProposal(owner, proposal.id, deps);
			expect(accepted).toMatchObject({ changed: true, proposal: { status: 'applied' } });
			expect(accepted.proposeAgain).toBeUndefined();
			expect(accepted.proposal.appliedVersion?.number).toBe(2);
			const v2 = await getProgramVersion(owner, programId, 2, { db });
			expect(v2.version).toMatchObject({
				current: true,
				summary: 'Re-planned for your new priorities'
			});
			expect(v2.decisions[0]).toMatchObject({
				kind: 'replanned',
				evidence: expect.objectContaining({
					from: NEXT_MONDAY,
					loads: expect.stringContaining('baselines.back_squat')
				})
			});
			expect(v2.blocks.find((b) => b.startsOn === NEXT_MONDAY)).toBeDefined();

			const again = await acceptProposal(owner, proposal.id, deps);
			expect(again).toMatchObject({ changed: false, proposal: { status: 'applied' } });
			expect(again.proposal.appliedVersion?.number).toBe(2);
			expect(await versionCount(db, programId)).toBe(2);
		});
	});

	it('splices a full taper in as version 2, the block around it kept on both sides', async () => {
		await withRollback(async (db) => {
			const { owner, programId, deps } = await seeded(db, 'block-end', WEDNESDAY);
			const raceOn = '2026-12-13';
			const race = await createGoal(
				owner,
				{
					...{ kind: 'event', title: '10K', disciplines: ['running'] },
					...{ eventType: '10K race', eventDate: raceOn }
				},
				{ db }
			);
			const directive: ReplanDirective = { kind: 'taper', goalRef: race.id, form: 'full' };
			const { proposal } = await propose(owner, { today: WEDNESDAY, directive }, deps);
			const decided = await acceptProposal(owner, proposal.id, deps);
			expect(decided.proposal).toMatchObject({ status: 'applied', appliedVersion: { number: 2 } });
			const v1 = await getProgramVersion(owner, programId, 1, { db });
			const v2 = await getProgramVersion(owner, programId, 2, { db });
			expect(v2.version.summary).toBe('A taper before 10K');
			const taper = v2.blocks.find((b) => b.phase === 'taper')!;
			expect(taper.startsOn <= raceOn && taper.endsOn >= raceOn).toBe(true);
			// The block before is shared as it was; the outline is cut before the taper and after it.
			expect(v2.blocks[0]!.id).toBe(v1.blocks[0]!.id);
			const outline = v1.blocks[1]!;
			expect(v2.blocks.map((b) => [b.phase, b.startsOn, b.endsOn])).toEqual([
				[v1.blocks[0]!.phase, v1.blocks[0]!.startsOn, v1.blocks[0]!.endsOn],
				[outline.phase, outline.startsOn, addDays(taper.startsOn, -1)],
				['taper', taper.startsOn, taper.endsOn],
				...(taper.endsOn < outline.endsOn
					? [[outline.phase, addDays(taper.endsOn, 1), outline.endsOn]]
					: [])
			]);
			const [replanned, planned] = v2.decisions;
			expect([replanned!.kind, planned!.kind]).toEqual(['replanned', 'taper_planned']);
			// Both name the taper block's row, not the block cut before it.
			expect(replanned!.affected).toEqual([taper.lineage]);
			expect(planned!.affected).toEqual([taper.lineage]);
		});
	});

	it('rejects with nothing changed', async () => {
		await withRollback(async (db) => {
			const { owner, programId, deps } = await seeded(db, 'block-end', WEDNESDAY);
			const { proposal } = await propose(owner, { today: WEDNESDAY, directive: PRIORITIES }, deps);
			const rejected = await rejectProposal(owner, proposal.id, { reason: 'Not now' }, deps);
			expect(rejected.proposal).toMatchObject({ status: 'rejected', appliedVersion: null });
			expect(await versionCount(db, programId)).toBe(1);
		});
	});
});

describe('staleness at accept', () => {
	it('a profile edit afterwards: profile_changed, with Propose again', async () => {
		await withRollback(async (db) => {
			const { owner, programId, deps } = await seeded(db, 'block-end', WEDNESDAY);
			const { proposal } = await propose(owner, { today: WEDNESDAY, directive: PRIORITIES }, deps);
			await createGoal(
				owner,
				{
					...{ kind: 'general', title: 'Run more', disciplines: ['running'] },
					...{ focus: 'Running', measure: 'Run three times a week' }
				},
				{ db }
			);
			const decided = await acceptProposal(owner, proposal.id, deps);
			expect(decided).toMatchObject({
				changed: true,
				proposeAgain: true,
				proposal: { status: 'superseded', supersededReason: 'profile_changed' }
			});
			expect(await versionCount(db, programId)).toBe(1);
		});
	});

	it('a logged set afterwards still applies, with the loads refreshed from it', async () => {
		await withRollback(async (db) => {
			const { owner, programId, deps } = await seeded(db, 'block-end', WEDNESDAY);
			const before = await previewReplan(
				owner,
				{ today: WEDNESDAY, directive: PRIORITIES },
				{ db, statementTimeoutMs: SLOW_OK }
			);
			if ('refusal' in before) throw new Error(before.why);
			const { proposal } = await propose(owner, { today: WEDNESDAY, directive: PRIORITIES }, deps);
			// This morning, after the squats the fixture logged today: the latest e1RM.
			await squatsAt(db, owner, atLocal(WEDNESDAY, '11:40', TZ), 150);

			const decided = await acceptProposal(owner, proposal.id, deps);
			expect(decided.proposal.status).toBe('applied');
			const v2 = await getProgramVersion(owner, programId, 2, { db });
			const was = Math.max(...squatSets(before.replan.plan.blocks).map((s) => s.reference1rm ?? 0));
			const now = Math.max(
				...squatSets(v2.blocks.filter((b) => b.startsOn >= NEXT_MONDAY)).map(
					(s) => s.reference1rm ?? 0
				)
			);
			expect(was).toBeGreaterThan(0);
			expect(now).toBeGreaterThan(was);
		});
	});

	it('a regenerating proposal accepted after its Monday: start_passed', async () => {
		await withRollback(async (db) => {
			const { owner, programId, deps } = await seeded(db, 'block-end', WEDNESDAY);
			const { proposal } = await propose(owner, { today: WEDNESDAY, directive: PRIORITIES }, deps);
			const late = { ...deps, now: clock(NEXT_TUESDAY) };
			const decided = await acceptProposal(owner, proposal.id, late);
			expect(decided).toMatchObject({
				proposeAgain: true,
				proposal: { status: 'superseded', supersededReason: 'start_passed' }
			});
			expect(await versionCount(db, programId)).toBe(1);
		});
	});

	it('a regenerating proposal whose Monday has something logged since: start_passed', async () => {
		await withRollback(async (db) => {
			// On a Monday a re-plan may start that same day, while nothing of it is logged.
			const { owner, programId, deps } = await seeded(db, 'week-complete', MONDAY);
			const { proposal } = await propose(owner, { today: MONDAY, directive: PRIORITIES }, deps);
			const v1 = await getProgramVersion(owner, programId, 1, { db });
			const today = sessionsOf(v1, MONDAY).find((s) => s.date === MONDAY)!;
			const startedAt = atLocal(MONDAY, '07:00', TZ);
			await db.insert(workouts).values({
				...{ ownerId: owner, clientId: crypto.randomUUID(), kind: 'strength' },
				...{ discipline: 'strength', sessionType: 'strength', title: today.title },
				...{ plannedSessionId: today.id, plannedLineageId: today.lineage, programId },
				...{ status: 'completed', startedAt },
				finishedAt: new Date(startedAt.getTime() + 3_600_000)
			});
			const decided = await acceptProposal(owner, proposal.id, deps);
			expect(decided).toMatchObject({
				proposeAgain: true,
				proposal: { status: 'superseded', supersededReason: 'start_passed' }
			});
			expect(await versionCount(db, programId)).toBe(1);
		});
	});

	it('a deload proposed Monday and accepted Thursday changes Thursday to Sunday only', async () => {
		await withRollback(async (db) => {
			const { owner, programId, deps } = await seeded(db, 'week-complete', MONDAY);
			const directive = deloadOf(MONDAY);
			const { proposal } = await propose(owner, { today: MONDAY, directive }, deps);
			const v1 = await getProgramVersion(owner, programId, 1, { db });
			const week = sessionsOf(v1, MONDAY);
			expect(week.length).toBeGreaterThan(3);

			const decided = await acceptProposal(owner, proposal.id, { ...deps, now: clock(THURSDAY) });
			expect(decided.proposal).toMatchObject({ status: 'applied', appliedVersion: { number: 2 } });
			const v2 = await getProgramVersion(owner, programId, 2, { db });
			const after = sessionsOf(v2, MONDAY);
			const strip = ({ id: _id, ...s }: (typeof week)[number]) =>
				JSON.parse(
					JSON.stringify(s, (key, value) => (key === 'id' ? undefined : (value as unknown)))
				) as unknown;
			const early = (s: { date: IsoDate }) => s.date < THURSDAY;
			expect(after.filter(early).map(strip)).toEqual(week.filter(early).map(strip));
			const late = after.filter((s) => !early(s));
			expect(late.length).toBeGreaterThan(0);
			expect(late.map(strip)).not.toEqual(week.filter((s) => !early(s)).map(strip));
			expect(v2.blocks.flatMap((b) => b.weeks).find((w) => w.startsOn === MONDAY)?.kind).toBe(
				'deload'
			);
			expect(v2.decisions.map((d) => d.kind)).toEqual([
				'deload_triggered',
				...late.map(() => 'load_eased')
			]);
			expect(v2.decisions.slice(1).flatMap((d) => d.affected)).toEqual(late.map((s) => s.lineage));
		});
	});

	it('a deload accepted after its week: sessions_passed', async () => {
		await withRollback(async (db) => {
			const { owner, programId, deps } = await seeded(db, 'week-complete', MONDAY);
			const { proposal } = await propose(
				owner,
				{ today: MONDAY, directive: deloadOf(MONDAY) },
				deps
			);
			const passed = await acceptProposal(owner, proposal.id, {
				...deps,
				now: clock(NEXT_TUESDAY)
			});
			expect(passed).toMatchObject({
				proposeAgain: true,
				proposal: { status: 'superseded', supersededReason: 'sessions_passed' }
			});
			expect(await versionCount(db, programId)).toBe(1);
		});
	});

	it('a newer program version: program_changed', async () => {
		await withRollback(async (db) => {
			const { owner, programId, deps } = await seeded(db, 'week-complete', MONDAY);
			const { proposal } = await propose(owner, { today: MONDAY, directive: PRIORITIES }, deps);
			const v1 = await getProgramVersion(owner, programId, 1, { db });
			const thursday = sessionsOf(v1, MONDAY).find((s) => s.date === THURSDAY)!;
			await skipSession(
				owner,
				{ sessionLineage: thursday.lineage },
				{ version: 1, today: MONDAY },
				{ db }
			);
			const decided = await acceptProposal(owner, proposal.id, deps);
			expect(decided).toMatchObject({
				proposeAgain: true,
				proposal: { status: 'superseded', supersededReason: 'program_changed' }
			});
			expect(await versionCount(db, programId)).toBe(2);
		});
	});
});

describe('a weekly review’s deload', () => {
	it('writes review_applied, so weekChanges names the review and its week', async () => {
		await withRollback(async (db) => {
			const { owner, programId, fixture, deps } = await seeded(db, 'week-complete', MONDAY);
			if (fixture.review.kind !== 'weekly') throw new Error('a weekly fixture');
			const reviewed = fixture.review.weekStartsOn;
			const { review } = await createWeeklyReview(
				owner,
				{ weekStartsOn: reviewed, today: MONDAY },
				deps
			);
			const { proposal } = await propose(
				owner,
				{
					today: MONDAY,
					directive: deloadOf(fixture.review.nextWeekStartsOn, 'reactive'),
					source: 'weekly_review',
					review: { reviewId: review.id, revision: review.revision, weekStartsOn: reviewed }
				},
				deps
			);
			expect(proposal.origin).toMatchObject({
				kind: 'weekly_review',
				reviewId: review.id,
				href: `/progress/reviews/w-${reviewed}`
			});

			await acceptProposal(owner, proposal.id, deps);
			const v2 = await getProgramVersion(owner, programId, 2, { db });
			const week = v2.blocks
				.flatMap((b) => b.weeks)
				.find((w) => w.startsOn === fixture.review.nextWeekStartsOn)!;
			const applied = v2.decisions.find((d) => d.kind === 'review_applied')!;
			expect(applied).toMatchObject({
				decidedBy: 'rules',
				evidence: { reviewId: review.id, revision: review.revision, trimmed: 0 }
			});
			expect(applied.affected.length).toBeGreaterThan(0);
			const changes = await weekChanges(
				owner,
				{ programId, version: 2, weekLineage: week.lineage },
				{ db }
			);
			expect(changes).toMatchObject({
				version: { number: 2, createdBy: 'rules' },
				applied: expect.stringContaining(`weekly review of`),
				review: { weekStartsOn: reviewed }
			});
			expect(changes!.changes[0]!.summary).toMatch(/^Deload in week \d$/);
		});
	});
});

describe('transactions and scope', () => {
	it('returns the same open replan, and revises it with a different one', async () => {
		await withRollback(async (db) => {
			const { owner, deps } = await seeded(db, 'block-end', WEDNESDAY);
			const first = await propose(owner, { today: WEDNESDAY, directive: PRIORITIES }, deps);
			const same = await propose(owner, { today: WEDNESDAY, directive: PRIORITIES }, deps);
			expect(same).toMatchObject({ duplicate: true, proposal: { id: first.proposal.id } });

			const other = await propose(owner, { today: WEDNESDAY, directive: MAINTENANCE }, deps);
			expect(other.proposal).toMatchObject({ status: 'proposed', revisionOf: first.proposal.id });
			expect(await getProposalView(owner, first.proposal.id, { db })).toMatchObject({
				status: 'superseded',
				supersededReason: 'revised'
			});
		});
	});

	it('completes inside a transaction holding the owner’s locks, on a pool of one connection', async () => {
		const pool = createPool(process.env.DATABASE_URL!, { max: 1, connectionTimeoutMs: 2_000 });
		const solo = createDatabase(pool);
		const ROLLBACK = new Error('rollback');
		const app = (getDb() as unknown as { $client: pg.Pool }).$client;
		const connect = vi.spyOn(app, 'connect');
		const query = vi.spyOn(app, 'query');
		try {
			await solo
				.transaction(async (tx) => {
					const { owner, deps } = await seeded(tx, 'block-end', WEDNESDAY);
					connect.mockClear();
					query.mockClear();
					await createReviewsRepository(tx).lock(owner);
					await createCoachProposalsRepository(tx).lockCreates(owner);
					const made = await propose(owner, { today: WEDNESDAY, directive: PRIORITIES }, deps);
					expect(made.proposal.status).toBe('proposed');
					expect(connect).not.toHaveBeenCalled();
					expect(query).not.toHaveBeenCalled();
					throw ROLLBACK;
				})
				.catch((error: unknown) => {
					if (error !== ROLLBACK) throw error;
				});
			expect(takeOverlaps()).toEqual([]);
		} finally {
			await pool.end();
		}
	});

	it('with the context’s reader stalled inside the accept transaction, applies with no overlap', async () => {
		const stall: ContextReader = async (db) => {
			await db.execute(sql`select pg_sleep(1)`);
			return null;
		};
		const requestId = crypto.randomUUID();
		const origin = {
			...{ requestId, method: 'POST', path: '/coach/proposals' },
			...{ routeId: '/(app)/coach/proposals/[[id]]', appVersion: '0.1.0+test' }
		};
		try {
			await withCommitted(async (db) => {
				const { owner, programId, deps } = await seeded(db, 'block-end', WEDNESDAY);
				const { proposal } = await propose(
					owner,
					{ today: WEDNESDAY, directive: PRIORITIES },
					deps
				);
				vi.spyOn(APPLIERS, 'replan').mockImplementation((input) =>
					applyReplan(input, { reader: stall, origin })
				);
				const decided = await acceptProposal(owner, proposal.id, deps);
				expect(decided.proposal.status).toBe('applied');
				expect(await versionCount(db, programId)).toBe(2);
				expect(takeOverlaps()).toEqual([]);
				const errors = await findErrorsByRequestId(requestId, { db });
				expect(errors.map((e) => e.context)).toEqual([
					expect.objectContaining({ part: 'evaluation-context', code: '57014' })
				]);
			});
		} finally {
			await getDb().execute(sql`delete from app_errors where request_id = ${requestId}`);
		}
	});

	it('a foreign owner is not found and writes nothing', async () => {
		await withRollback(async (db) => {
			const { owner, deps } = await seeded(db, 'block-end', WEDNESDAY);
			const { proposal } = await propose(owner, { today: WEDNESDAY, directive: PRIORITIES }, deps);
			const other = await makeSecondOwner(db);
			const before = await writes(db);
			expect(
				await proposeReplan(
					other,
					{ today: WEDNESDAY, directive: PRIORITIES, source: 'owner' },
					deps
				)
			).toMatchObject({ status: 'refused', refusal: 'no_program' });
			await expect(acceptProposal(other, proposal.id, deps)).rejects.toBeInstanceOf(
				CoachNotFoundError
			);
			await expect(rejectProposal(other, proposal.id, {}, deps)).rejects.toBeInstanceOf(
				CoachNotFoundError
			);
			await expect(getProposalView(other, proposal.id, { db })).rejects.toBeInstanceOf(
				CoachNotFoundError
			);
			expect(await writes(db)).toEqual(before);
			expect((await getProposalView(owner, proposal.id, { db })).status).toBe('proposed');
		});
	});

	it('holds M5’s content guard: a stored replan’s payload never changes', async () => {
		await withRollback(async (db) => {
			const { owner, deps } = await seeded(db, 'block-end', WEDNESDAY);
			const { proposal } = await propose(owner, { today: WEDNESDAY, directive: PRIORITIES }, deps);
			const error = await db
				.transaction(async (tx) => {
					await tx.execute(
						sql`update coach_proposals set payload = jsonb_set(payload, '{from}', '"2026-11-30"')
							where id = ${proposal.id}`
					);
				})
				.then(
					() => null,
					(err: unknown) =>
						((err as { cause?: object }).cause ?? err) as {
							code: string;
							constraint: string;
						}
				);
			expect(error).toMatchObject({ code: '23001', constraint: 'coach_proposals_content_guard' });
		});
	});
});
