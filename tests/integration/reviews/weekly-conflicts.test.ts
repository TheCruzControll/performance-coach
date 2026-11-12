/**
 * The weekly review judged by M7's evaluator (m7/24 review-conflicts-engine) on real Postgres,
 * from M6's week-complete fixture (reviewed week 9–15 Nov 2026, next week 16–22 Nov, Los Angeles)
 * plus sessions logged here:
 * - the conflicts section judges the week as performed on the logged load: hard sparring logged
 *   on Monday, then heavy squats on Tuesday, is a residual-fatigue conflict with its why, and
 *   every conflict M6's checkWeek listed is still listed
 * - next week's moves are repairWeek's, each checked with evaluateWeek: a move onto the day after
 *   a logged hard session is not proposed, with the finding's headline as its reason, and once
 *   the proposal is accepted Train's evaluation of the new version has nothing on a moved session
 * - a stalled context read inside createWeeklyReview's transaction, under the one-query guard:
 *   the review is created on M6's checkWeek path, with an app_errors row and no overlap
 * - the same week gives the same snapshot bytes, and a review stored on M6's path still reads
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { IsoDate } from '../../../src/lib/domain/calendar';
import type { ProgramOp } from '../../../src/lib/domain/coach/proposals';
import type { Finding } from '../../../src/lib/domain/programming/review/brief';
import { CONCURRENT_RULES } from '../../../src/lib/domain/programming/rules/concurrent';
import type { Executor } from '../../../src/lib/server/db';
import { findErrorsByRequestId } from '../../../src/lib/server/services/errors';
import type { ContextReader } from '../../../src/lib/server/services/periodisation/context';
import { getWeekEvaluation } from '../../../src/lib/server/services/periodisation/evaluate';
import { skipSession } from '../../../src/lib/server/services/programs/edits';
import {
	createWeeklyReview,
	decideNextWeek,
	getWeeklyReviewView
} from '../../../src/lib/server/services/reviews';
import type { WeeklyReviewDeps } from '../../../src/lib/server/services/reviews/weekly';
import {
	finishWorkout,
	logOtherSession,
	logSet,
	startWorkout
} from '../../../src/lib/server/services/training/log';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import { withRollback } from '../helpers';
import { takeOverlaps } from '../one-query-per-client';
import { makeOwner } from '../profile/fixtures';

const TZ = 'America/Los_Angeles';
const REVIEWED = '2026-11-09';
const NEXT = '2026-11-16';
const TUESDAY = '2026-11-17';
/** Real-data reads on a loaded CI runner: far above the 300 ms default, which the stall tests. */
const SLOW_OK = { statementTimeoutMs: 10_000 };
/** The context reads skipped: the review keeps M6's checkWeek path. */
const M6_PATH = { reader: async () => null };

const origin = (requestId = crypto.randomUUID()) => ({
	requestId,
	method: 'POST',
	path: '/progress/reviews',
	routeId: '/(app)/progress/reviews/[[key]]',
	appVersion: '0.1.0+test'
});

/** week-complete as of `day` at `time`, and the deps that review it then. */
async function seeded(db: Executor, day: IsoDate, time = '12:00') {
	const owner = await makeOwner(db);
	const now = () => atLocal(day, time, TZ);
	const fixture = (await seedAnalyticsFixture(
		owner,
		'week-complete',
		{ timeZone: TZ, now: now() },
		{ db }
	)) as unknown as { exercises: Record<string, string> };
	return { owner, now, day, exercises: fixture.exercises, deps: { db, now } };
}
type Seeded = Awaited<ReturnType<typeof seeded>>;

/** An unplanned workout started at `at` (Los Angeles), logged with `during`, then finished. */
async function logged(
	db: Executor,
	s: Seeded,
	at: Date,
	what: { kind: 'strength' | 'other'; discipline: string; sessionType: string; title: string },
	finish: { minutes: number; rpe: number },
	during: (clientId: string) => Promise<unknown>
) {
	const clientId = crypto.randomUUID();
	const { workout } = await startWorkout(
		s.owner,
		{ clientId, ...what, plannedSessionId: null, startedAt: at.toISOString() },
		{ db }
	);
	await during(clientId);
	const finishedAt = new Date(at.getTime() + finish.minutes * 60_000).toISOString();
	const done = { durationSeconds: finish.minutes * 60, sessionRpe: finish.rpe };
	await finishWorkout(s.owner, clientId, { status: 'completed', finishedAt, ...done }, { db });
	return workout.id;
}

/** Two and a half hours of hard sparring on `day` at 10:00. */
const sparring = (db: Executor, s: Seeded, day: IsoDate) =>
	logged(
		db,
		s,
		atLocal(day, '10:00', TZ),
		{ kind: 'other', discipline: 'muay_thai', sessionType: 'muay_thai', title: 'Open mat' },
		{ minutes: 150, rpe: 9.5 },
		(workoutClientId) =>
			logOtherSession(
				s.owner,
				{
					workoutClientId,
					kind: 'sparring',
					durationMinutes: 150,
					rpe: 9.5,
					metrics: [],
					notes: null
				},
				{ db }
			)
	);

/** Five heavy sets of back squats on `day` at 07:00. */
const squats = (db: Executor, s: Seeded, day: IsoDate) => {
	const at = atLocal(day, '07:00', TZ);
	return logged(
		db,
		s,
		at,
		{ kind: 'strength', discipline: 'strength', sessionType: 'strength', title: 'Heavy squats' },
		{ minutes: 60, rpe: 9 },
		async (workoutClientId) => {
			for (let setIndex = 1; setIndex <= 5; setIndex++)
				await logSet(
					s.owner,
					{
						...{ clientMutationId: crypto.randomUUID(), workoutClientId },
						...{ exerciseId: s.exercises.back_squat!, plannedExerciseLineageId: null },
						...{ exercisePosition: 1, setIndex, weight: 140, unit: 'kg', reps: 5, missedReps: 0 },
						...{ rpe: 9, seconds: null, metres: null, isExtra: false, isSkipped: false },
						isWarmup: false,
						performedAt: new Date(at.getTime() + setIndex * 5 * 60_000).toISOString()
					},
					{ db }
				);
		}
	);
};

const review = (s: Seeded, context: WeeklyReviewDeps['context'] = SLOW_OK) =>
	createWeeklyReview(
		s.owner,
		{ weekStartsOn: REVIEWED, today: s.day },
		{ ...s.deps, context }
	).then(({ review }) => review);

const findingsOf = async (s: Seeded) =>
	(await getWeeklyReviewView(s.owner, REVIEWED, s.deps)).snapshot!.brief.findings;
const conflictsOf = async (s: Seeded) =>
	(await findingsOf(s)).filter((f) => f.section === 'conflicts');

const opsOf = async (db: Executor, proposalId: string) =>
	(
		await db.execute<{ payload: { ops: ProgramOp[] } }>(
			sql`select payload from coach_proposals where id = ${proposalId}`
		)
	).rows[0]!.payload.ops;

/** A conflict entry as the review page shows it, whatever its place in the list. */
const entry = (f: Finding) => ({
	rule: f.id.split(':').at(-1),
	label: f.label,
	verdict: f.verdict,
	window: f.window,
	sources: f.sources
});

describe('the conflicts section', () => {
	it('lists hard sparring logged Monday, then heavy squats Tuesday, as residual fatigue with its why', async () => {
		await withRollback(async (db) => {
			const s = await seeded(db, TUESDAY);
			const spar = await sparring(db, s, REVIEWED);
			const squat = await squats(db, s, '2026-11-10');
			await review(s);

			// The one the squats suffer (the squats, tiring the legs, cause three more later in the week).
			const residual = (await conflictsOf(s)).filter(
				(f) =>
					f.id.endsWith(':concurrent.residual_fatigue_before_hard') &&
					f.window?.from === REVIEWED &&
					f.sources.some((r) => r.id === squat)
			);
			expect(residual).toHaveLength(1);
			const { why, headline } = CONCURRENT_RULES.residual_fatigue_before_hard;
			expect(residual[0]).toMatchObject({
				label: headline,
				window: { from: REVIEWED, to: '2026-11-10', label: '2 days' },
				verdict: { level: 'watch' }
			});
			// The day's sessions that left it: Strength A and the sparring, then the squats.
			expect(residual[0]!.sources.map((r) => r.id)).toEqual(expect.arrayContaining([spar, squat]));
			expect(residual[0]!.verdict.words).toMatch(
				/Open mat on Monday, then Heavy squats on Tuesday, with .+ still overloaded\. /
			);
			expect(residual[0]!.verdict.words.endsWith(why)).toBe(true);
		});
	});

	it('still lists every conflict M6’s checkWeek listed: a superset', async () => {
		const listed = async (context: WeeklyReviewDeps['context']) => {
			let found: Finding[] = [];
			await withRollback(async (db) => {
				const s = await seeded(db, TUESDAY);
				await review(s, context);
				found = await conflictsOf(s);
			});
			return found;
		};
		const m6 = await listed(M6_PATH);
		const m7 = await listed(SLOW_OK);
		// Two heavy leg days before hard Muay Thai, as M6 listed them; workout ids differ by run.
		const shape = (f: Finding) => ({ ...entry(f), sources: f.sources.map((r) => r.label).sort() });
		expect(m6.map((f) => f.id)).toEqual([
			'conflicts:1:heavy_lower_before_hard',
			'conflicts:2:heavy_lower_before_hard'
		]);
		expect(m7.map(shape)).toEqual(expect.arrayContaining(m6.map(shape)));
		// And what M7's rules add, on the load logged: residual fatigue, the hard-day cap and three
		// hard days in a row.
		expect(m7.map((f) => f.id)).toEqual([
			'conflicts:1:heavy_lower_before_hard',
			'conflicts:2:concurrent.residual_fatigue_before_hard',
			'conflicts:3:concurrent.hard_days_cap',
			'conflicts:4:heavy_lower_before_hard',
			'conflicts:5:concurrent.residual_fatigue_before_hard',
			'conflicts:6:concurrent.residual_fatigue_before_hard',
			'conflicts:7:concurrent.three_hard_days'
		]);
	});
});

describe("next week's moves", () => {
	it('never proposes a move onto the day after a logged hard session, and says why', async () => {
		await withRollback(async (db) => {
			// Reviewed early on Monday, with Sunday's open mat logged: the scheduler's answer to
			// Thursday's heavy deadlifts before Friday's sparring puts Sparring on Monday.
			const s = await seeded(db, NEXT, '06:00');
			await sparring(db, s, '2026-11-15');
			const stored = await review(s);

			const ops = stored.proposalId ? await opsOf(db, stored.proposalId) : [];
			expect(ops.filter((op) => op.op === 'move' && op.toDate === NEXT)).toEqual([]);
			const view = await getWeeklyReviewView(s.owner, REVIEWED, s.deps);
			const refused = view.notProposed.find((f) => f.label.includes('Moving Sparring to Mon'));
			expect(refused?.verdict.words).toBe(CONCURRENT_RULES.residual_fatigue_before_hard.headline);
		});
	});

	it('proposes no move that a finding still ahead names: the hard-day cap names every hard session', async () => {
		await withRollback(async (db) => {
			const s = await seeded(db, TUESDAY);
			const stored = await review(s);
			// Four hard days against the cap: Sparring to Sunday would still be one of them on Train.
			expect(stored.proposalId).toBeNull();
			const view = await getWeeklyReviewView(s.owner, REVIEWED, s.deps);
			const refused = view.notProposed.find((f) => f.label.includes('Moving Sparring to Sun'));
			expect(refused?.verdict.words).toBe(CONCURRENT_RULES.hard_days_cap.headline);
		});
	});

	it('proposes repairWeek’s moves, and once accepted Train finds nothing on a moved session', async () => {
		await withRollback(async (db) => {
			const s = await seeded(db, TUESDAY);
			// Three hard days, within an intermediate's cap: Saturday's long run skipped.
			await db.execute(
				sql`insert into discipline_experience (owner_id, discipline, level) values (${s.owner}, 'strength', 'intermediate')`
			);
			const longRun = await db.execute<{ lineage: string }>(
				sql`select lineage_id as lineage from planned_sessions where title = 'Long run' and scheduled_on = '2026-11-21'`
			);
			const at = { version: 1, today: TUESDAY };
			await skipSession(s.owner, { sessionLineage: longRun.rows[0]!.lineage }, at, { db });
			const stored = await review(s);
			const moves = (await opsOf(db, stored.proposalId!)).filter((op) => op.op === 'move');
			// Friday's sparring to Sunday, away from Thursday's heavy deadlifts.
			expect(moves.map((m) => m.toDate)).toEqual(['2026-11-22']);
			for (const m of moves) expect(m.reason).toMatch(/^Heavy lower body the day before hard/);

			const items = (await getWeeklyReviewView(s.owner, REVIEWED, s.deps)).proposal!;
			const head = await db.execute<{ evidence: { adjustments: { id: string }[] } }>(
				sql`select evidence from coach_proposals where id = ${items.id}`
			);
			const decided = await decideNextWeek(
				s.owner,
				stored.id,
				{
					items: head.rows[0]!.evidence.adjustments.map(({ id }) => ({
						id,
						choice: 'proposed' as const
					}))
				},
				s.deps
			);
			if (decided.outcome !== 'applied')
				throw new Error(`expected applied, got ${decided.outcome}`);
			const week = await getWeekEvaluation(
				s.owner,
				{ version: decided.versionNumber!, weekStartsOn: NEXT, today: TUESDAY },
				{ db, ...SLOW_OK }
			);
			// No actionable finding, so no note, on any moved lineage.
			for (const m of moves) expect(week.notes[m.sessionLineage]).toBeUndefined();
		});
	});
});

describe('robustness', () => {
	it('with the context read stalled in its transaction: M6’s checkWeek path, recorded, no overlap', async () => {
		const stall: ContextReader = async (db) => {
			await db.execute(sql`select pg_sleep(1)`);
			return null;
		};
		await withRollback(async (db) => {
			const s = await seeded(db, TUESDAY);
			const { requestId } = origin();
			const stored = await review(s, { reader: stall, origin: origin(requestId) });
			expect(stored.revision).toBe(1);
			// M6's move: Friday's sparring to Saturday, and conflicts by checkWeek alone.
			const ops = await opsOf(db, stored.proposalId!);
			expect(ops).toEqual([expect.objectContaining({ op: 'move', toDate: '2026-11-21' })]);
			expect((await conflictsOf(s)).every((f) => !f.id.includes('concurrent.'))).toBe(true);
			const [row] = await findErrorsByRequestId(requestId, { db });
			expect(row?.context).toMatchObject({ part: 'evaluation-context', code: '57014' });
			expect(takeOverlaps()).toEqual([]);
		});
	});

	it('gives the same snapshot bytes for the same week', async () => {
		await withRollback(async (db) => {
			const s = await seeded(db, TUESDAY);
			const ROLLBACK = new Error('rollback');
			const once = async () => {
				let snapshot = '';
				await db
					.transaction(async (tx) => {
						const inTx = { ...s, deps: { db: tx, now: s.now } };
						await review(inTx);
						snapshot = JSON.stringify(
							(await getWeeklyReviewView(s.owner, REVIEWED, inTx.deps)).snapshot
						);
						throw ROLLBACK;
					})
					.catch((error: unknown) => {
						if (error !== ROLLBACK) throw error;
					});
				return snapshot;
			};
			const first = await once();
			expect(first).toContain('concurrent.residual_fatigue_before_hard');
			expect(await once()).toBe(first);
		});
	});

	it('reads a review stored on M6’s path as it was stored', async () => {
		await withRollback(async (db) => {
			const s = await seeded(db, TUESDAY);
			const stored = await review(s, M6_PATH);
			const view = await getWeeklyReviewView(s.owner, REVIEWED, s.deps);
			expect(view.legacy).toBe(false);
			expect(view.snapshot).toEqual(stored.read.legacy ? null : stored.read.snapshot);
			expect(
				view.sections.find((x) => x.section === 'conflicts')!.findings.map((f) => f.id)
			).toEqual(['conflicts:1:heavy_lower_before_hard', 'conflicts:2:heavy_lower_before_hard']);
		});
	});
});
