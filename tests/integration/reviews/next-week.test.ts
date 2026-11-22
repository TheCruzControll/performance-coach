/**
 * Deciding next week on real Postgres (services/reviews/next-week.ts, the M6 plan's
 * next-week-decide), from the week-complete review fixture at a forced today:
 * - accepting applies exactly the proposed changes as one version, with each change's why and a
 *   review_applied decision, and leaves the previous version as it was
 * - leaving a change out or taking a half step applies an owner revision of exactly those ops
 * - rejecting stores the note and makes no version; a retry never applies twice
 * - a program edited since the review supersedes it
 * - a Monday proposal decided on Thursday drops Monday's changes, from the review or after M5's
 *   inbox superseded it as sessions_passed; with every change past, nothing is written
 * - the inbox and the review apply an untouched proposal the same way
 * - everything is owner-scoped
 * The reviewed week is 9–15 Nov 2026 in Los Angeles; next week is 16–22 Nov.
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { IsoDate } from '../../../src/lib/domain/calendar';
import type { ProgramOp } from '../../../src/lib/domain/coach/proposals';
import type { Executor } from '../../../src/lib/server/db';
import { acceptProposal } from '../../../src/lib/server/services/coach/proposals';
import {
	getProgramVersion,
	getVersionHistory,
	skipSession
} from '../../../src/lib/server/services/programs/index';
import {
	createWeeklyReview,
	decideNextWeek,
	getWeeklyReviewView,
	refreshWeeklyReview,
	ReviewNotFoundError,
	TOO_LATE,
	WeeklyReviewRefreshError,
	type NextWeekItem
} from '../../../src/lib/server/services/reviews';
import { finishWorkout, logSet, startWorkout } from '../../../src/lib/server/services/training/log';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const TZ = 'America/Los_Angeles';
const REVIEWED = '2026-11-09';
const NEXT = '2026-11-16';
const MONDAY = '2026-11-16';
const TUESDAY = '2026-11-17';
const THURSDAY = '2026-11-19';
const SUNDAY = '2026-11-22';
const at = (day: IsoDate) => () => atLocal(day, '12:00', TZ);

interface Adjustment {
	id: string;
	sessionDate: IsoDate;
	halfStep: ProgramOp | null;
}
type ProposalRow = {
	id: string;
	status: string;
	superseded_reason: string | null;
	decision_note: string | null;
	revision_of: string | null;
	payload: { ops: ProgramOp[] };
	evidence: { adjustments?: Adjustment[]; source: Record<string, unknown> };
};

const proposalRow = async (db: Executor, id: string) =>
	(await db.execute<ProposalRow>(sql`select * from coach_proposals where id = ${id}`)).rows[0]!;

const proposalCount = async (db: Executor, owner: string) =>
	(
		await db.execute<{ n: number }>(
			sql`select count(*)::int as n from coach_proposals where owner_id = ${owner}`
		)
	).rows[0]!.n;

const versionCount = async (db: Executor, owner: string) =>
	(
		await db.execute<{ n: number }>(
			sql`select count(*)::int as n from program_versions v join programs p on p.id = v.program_id
				where p.owner_id = ${owner}`
		)
	).rows[0]!.n;

/** Add a bench line at a fixed 85 kg on `date` (the fixture's are RPE-based, which hold). */
async function loadLine(
	db: Executor,
	owner: string,
	bench: string,
	date: IsoDate,
	position: number
) {
	const { rows } = await db.execute<{ id: string }>(
		sql`select pe.id::text as id from planned_exercises pe
			join planned_sessions ps on ps.id = pe.session_id
			join program_version_weeks vw on vw.week_id = ps.week_id
			join programs p on p.current_version_id = vw.version_id
			where p.owner_id = ${owner} and ps.scheduled_on = ${date} and pe.exercise_id = ${bench}`
	);
	expect(rows).toHaveLength(1);
	await db.execute(
		sql`insert into set_prescriptions (planned_exercise_id, position, role, sets, reps_min,
				reps_max, target_rpe, load_kind, load_value, load_unit, rest_seconds)
			values (${rows[0]!.id}, ${position}, 'working', 3, 5, 5, 8, 'absolute', 85, 'kg', 150)`
	);
}

/**
 * week-complete seeded and reviewed on `day`, with fixed-load bench lines on Thursday (position 2)
 * and on Monday (positions 2–4, when `monday`): each proposes +2.5 kg, beside Friday's sparring
 * moved to Saturday.
 */
async function reviewed(db: Executor, day: IsoDate, { monday = false } = {}) {
	const owner = await makeOwner(db);
	const now = at(day);
	const seeded = (await seedAnalyticsFixture(
		owner,
		'week-complete',
		{ timeZone: TZ, now: now() },
		{
			db
		}
	)) as unknown as { exercises: Record<string, string> };
	const bench = seeded.exercises.bench_press!;
	await loadLine(db, owner, bench, THURSDAY, 2);
	if (monday) for (const position of [2, 3, 4]) await loadLine(db, owner, bench, MONDAY, position);
	const deps = { db, now };
	// M6's checkWeek path (the context reads skipped): with M7's judge the hard week's next week has
	// no move a finding would not name (m7/24), and these tests decide M6's proposal.
	const m6 = { ...deps, context: { reader: async () => null } };
	const { review } = await createWeeklyReview(owner, { weekStartsOn: REVIEWED, today: day }, m6);
	const head = await proposalRow(db, review.proposalId!);
	const adjustments = head.evidence.adjustments!;
	const all = (choice: NextWeekItem['choice'] = 'proposed') =>
		adjustments.map(({ id }) => ({ id, choice }));
	const program = async () =>
		(
			await db.execute<{ program_id: string; number: number }>(
				sql`select p.id::text as program_id, v.number from programs p
					join program_versions v on v.id = p.current_version_id where p.owner_id = ${owner}`
			)
		).rows[0]!;
	return { owner, deps, bench, review, head, adjustments, all, program };
}

/** The version's next week, without row ids (a copied week has fresh ones). */
async function nextWeek(db: Executor, owner: string, programId: string, number: number) {
	const version = await getProgramVersion(owner, programId, number, { db });
	const week = version.blocks.flatMap((b) => b.weeks).find((w) => w.startsOn === NEXT)!;
	return JSON.parse(JSON.stringify(week, (k, v: unknown) => (k === 'id' ? undefined : v)));
}

/** A bench set logged now in an ad hoc workout on the reviewed week's Wednesday. */
async function lateSet(db: Executor, owner: string, benchId: string) {
	const startedAt = atLocal('2026-11-11', '18:00', TZ);
	const clientId = crypto.randomUUID();
	const workout = { clientId, kind: 'strength', discipline: 'strength', sessionType: 'strength' };
	const title = 'Extra bench';
	await startWorkout(
		owner,
		{ ...workout, title, plannedSessionId: null, startedAt: startedAt.toISOString() },
		{ db }
	);
	await logSet(
		owner,
		{
			...{ clientMutationId: crypto.randomUUID(), workoutClientId: clientId },
			...{ exerciseId: benchId, plannedExerciseLineageId: null, exercisePosition: 1, setIndex: 1 },
			...{ weight: 60, unit: 'kg', reps: 5, missedReps: 0, rpe: 6, seconds: null, metres: null },
			...{ isExtra: false, isSkipped: false, isWarmup: false },
			performedAt: new Date(startedAt.getTime() + 60_000).toISOString()
		},
		{ db }
	);
	const finishedAt = new Date(startedAt.getTime() + 20 * 60_000).toISOString();
	const done = { status: 'completed', finishedAt, durationSeconds: 1200, sessionRpe: 6 };
	await finishWorkout(owner, clientId, done, { db });
}

const opOf = (ops: ProgramOp[], kind: ProgramOp['op']) => ops.find((op) => op.op === kind)!;

describe('generating next week', () => {
	it('applies exactly the proposed changes as one version, leaving the previous one as it was', async () => {
		await withRollback(async (db) => {
			const r = await reviewed(db, TUESDAY);
			const before = await r.program();
			const versions = await versionCount(db, r.owner);
			const oldWeek = await nextWeek(db, r.owner, before.program_id, before.number);
			const ops = r.head.payload.ops;
			expect(ops.map((op) => op.op).sort()).toEqual(['adjust_set', 'move']);

			const decided = await decideNextWeek(r.owner, r.review.id, { items: r.all() }, r.deps);
			expect(decided).toMatchObject({
				outcome: 'applied',
				proposalId: r.head.id,
				versionNumber: before.number + 1,
				passed: 0
			});
			expect(await versionCount(db, r.owner)).toBe(versions + 1);

			// Bench's Thursday line +2.5 kg and sparring on Saturday: nothing else changed.
			const set = opOf(ops, 'adjust_set') as Extract<ProgramOp, { op: 'adjust_set' }>;
			const move = opOf(ops, 'move') as Extract<ProgramOp, { op: 'move' }>;
			expect(set).toMatchObject({ loadValue: 87.5 });
			const newWeek = await nextWeek(db, r.owner, before.program_id, before.number + 1);
			const after = (lineage: string) =>
				newWeek.sessions.find((s: { lineage: string }) => s.lineage === lineage);
			const expected = structuredClone(oldWeek);
			for (const session of expected.sessions) {
				// What M3's edits derive themselves: a moved session's status and place in its new
				// day, and an edited session's estimate worked out again.
				if (session.lineage === move.sessionLineage) {
					const { orderInDay } = after(session.lineage);
					Object.assign(session, { movedFrom: session.date, date: move.toDate, orderInDay });
					session.status = 'moved';
				}
				if (session.lineage === set.sessionLineage) {
					const { estMinutes, estLoad } = after(session.lineage);
					Object.assign(session, { estMinutes, estLoad });
				}
				for (const exercise of session.exercises ?? [])
					if (exercise.lineage === set.plannedExerciseLineage)
						exercise.sets[set.position - 1].loadValue = 87.5;
			}
			const byLineage = (w: { sessions: { lineage: string }[] }) =>
				Object.fromEntries(w.sessions.map((s) => [s.lineage, s]));
			expect(byLineage(newWeek)).toEqual(byLineage(expected));
			expect({ ...newWeek, sessions: [] }).toEqual({ ...expected, sessions: [] });
			// History never changes.
			expect(await nextWeek(db, r.owner, before.program_id, before.number)).toEqual(oldWeek);
		});
	});

	it("lists each change's why and the review_applied decision in the version's history", async () => {
		await withRollback(async (db) => {
			const r = await reviewed(db, TUESDAY);
			await decideNextWeek(r.owner, r.review.id, { items: r.all() }, r.deps);
			const [latest] = (await getVersionHistory(r.owner, {}, { db }))!.versions;
			expect(latest).toMatchObject({
				summary: 'Next week from your review of 9 Nov',
				createdBy: 'rules'
			});
			const decisions = latest!.decisions;
			expect(decisions.map((d) => d.kind).sort()).toEqual([
				'prescription_adjusted',
				'review_applied',
				'session_moved'
			]);
			expect(decisions.every((d) => d.decidedBy === 'rules')).toBe(true);
			const set = opOf(r.head.payload.ops, 'adjust_set') as { reason: string };
			const adjusted = decisions.find((d) => d.kind === 'prescription_adjusted')!;
			expect(adjusted.why).toMatch(/^The programming rules changed /);
			expect(adjusted.why).toContain(set.reason);
			expect(decisions.find((d) => d.kind === 'review_applied')).toMatchObject({
				summary: 'Applied 2 changes from your weekly review of 9 Nov',
				why: 'The programming rules applied 2 changes from your weekly review of 9 Nov. Each change says why in its own decision.'
			});
		});
	});

	it('applies an owner revision of exactly the chosen ops, then refuses a refresh', async () => {
		await withRollback(async (db) => {
			const r = await reviewed(db, TUESDAY);
			const before = await r.program();
			const set = r.adjustments.find((a) => a.halfStep !== null)!;
			expect(set.halfStep).toMatchObject({ op: 'adjust_set', loadValue: 86.25 });
			// The move is left out and bench taken at its half step.
			const items = [{ id: set.id, choice: 'half_step' as const }];
			const decided = await decideNextWeek(r.owner, r.review.id, { items }, r.deps);
			expect(decided).toMatchObject({ outcome: 'applied', versionNumber: before.number + 1 });
			const revisionId = decided.outcome === 'applied' ? decided.proposalId : '';
			expect(revisionId).not.toBe(r.head.id);

			const revision = await proposalRow(db, revisionId);
			expect(revision).toMatchObject({ status: 'applied', revision_of: r.head.id });
			expect(revision.payload.ops).toEqual([set.halfStep]);
			expect(revision.evidence.source).toMatchObject({
				reviewId: r.review.id,
				modifiedBy: 'owner'
			});
			expect(revision.evidence.source.trimmed).toBeUndefined();
			expect(await proposalRow(db, r.head.id)).toMatchObject({
				status: 'superseded',
				superseded_reason: 'revised'
			});
			const [latest] = (await getVersionHistory(r.owner, {}, { db }))!.versions;
			expect(latest!.createdBy).toBe('owner');
			expect(latest!.decisions.map((d) => [d.kind, d.decidedBy, d.why.split(' ')[0]])).toEqual([
				['prescription_adjusted', 'owner', 'You'],
				['review_applied', 'owner', 'You']
			]);
			const week = await nextWeek(db, r.owner, before.program_id, before.number + 1);
			const moved = week.sessions.filter((s: { movedFrom: string | null }) => s.movedFrom);
			expect(moved).toEqual([]);

			const view = await getWeeklyReviewView(r.owner, REVIEWED, r.deps);
			expect(view.decision).toEqual({
				state: 'applied',
				proposalId: revisionId,
				versionId: decided.outcome === 'applied' ? decided.versionId : null,
				versionNumber: before.number + 1
			});
			await lateSet(db, r.owner, r.bench);
			const refused = refreshWeeklyReview(r.owner, r.review.id, { today: TUESDAY }, r.deps);
			await expect(refused).rejects.toBeInstanceOf(WeeklyReviewRefreshError);
			await expect(refused).rejects.toMatchObject({ reason: 'decided' });
		});
	});

	it('rejects with the note and makes no version', async () => {
		await withRollback(async (db) => {
			const r = await reviewed(db, TUESDAY);
			const versions = await versionCount(db, r.owner);
			const note = 'Travelling this week';
			const decided = await decideNextWeek(r.owner, r.review.id, { items: [], note }, r.deps);
			expect(decided).toEqual({ outcome: 'rejected', proposalId: r.head.id });
			expect(await proposalRow(db, r.head.id)).toMatchObject({
				status: 'rejected',
				decision_note: note
			});
			expect(await versionCount(db, r.owner)).toBe(versions);
			expect((await getWeeklyReviewView(r.owner, REVIEWED, r.deps)).decision.state).toBe(
				'rejected'
			);
		});
	});

	it('applies a double submit once', async () => {
		await withRollback(async (db) => {
			const r = await reviewed(db, TUESDAY);
			const versions = await versionCount(db, r.owner);
			const first = await decideNextWeek(r.owner, r.review.id, { items: r.all() }, r.deps);
			const again = await decideNextWeek(r.owner, r.review.id, { items: r.all() }, r.deps);
			expect(again).toEqual(first);
			expect(await versionCount(db, r.owner)).toBe(versions + 1);
			expect(await proposalCount(db, r.owner)).toBe(1);
		});
	});

	it('is superseded when the program was edited after the review', async () => {
		await withRollback(async (db) => {
			const r = await reviewed(db, TUESDAY);
			const before = await r.program();
			const set = opOf(r.head.payload.ops, 'adjust_set');
			await skipSession(
				r.owner,
				{ sessionLineage: set.sessionLineage, reason: 'Away' },
				{ version: before.number, today: TUESDAY },
				{ db }
			);
			const decided = await decideNextWeek(r.owner, r.review.id, { items: r.all() }, r.deps);
			expect(decided).toEqual({
				outcome: 'superseded',
				proposalId: r.head.id,
				reason: 'program_changed'
			});
			expect((await r.program()).number).toBe(before.number + 1);
			expect(await proposalRow(db, r.head.id)).toMatchObject({
				status: 'superseded',
				superseded_reason: 'program_changed'
			});
		});
	});
});

describe('deciding late', () => {
	it("drops a Monday proposal's Monday changes on Thursday and applies the rest", async () => {
		await withRollback(async (db) => {
			const r = await reviewed(db, MONDAY, { monday: true });
			const mondays = r.adjustments.filter((a) => a.sessionDate === MONDAY);
			expect(mondays).toHaveLength(3);
			const before = await r.program();
			const thursday = { db, now: at(THURSDAY) };
			const decided = await decideNextWeek(r.owner, r.review.id, { items: r.all() }, thursday);
			expect(decided).toMatchObject({
				outcome: 'applied',
				versionNumber: before.number + 1,
				passed: 3
			});
			const revision = await proposalRow(
				db,
				decided.outcome === 'applied' ? decided.proposalId : ''
			);
			const rest = r.head.payload.ops.filter((_, i) => r.adjustments[i]!.sessionDate !== MONDAY);
			expect(rest.length).toBe(r.head.payload.ops.length - 3);
			expect(revision).toMatchObject({ status: 'applied', revision_of: r.head.id });
			expect(revision.payload.ops).toEqual(rest);
			expect(revision.evidence.source).toMatchObject({ trimmed: 3 });
			expect(revision.evidence.source.modifiedBy).toBeUndefined();
			const [latest] = (await getVersionHistory(r.owner, {}, { db }))!.versions;
			expect(latest!.decisions.find((d) => d.kind === 'review_applied')).toMatchObject({
				decidedBy: 'rules',
				why: `The programming rules applied ${rest.length} changes from your weekly review of 9 Nov. 3 changes were for sessions already past, so left out.`
			});
		});
	});

	it("is superseded as sessions_passed by M5's accept, then finished in the review", async () => {
		await withRollback(async (db) => {
			const r = await reviewed(db, MONDAY, { monday: true });
			const before = await r.program();
			const thursday = { db, now: at(THURSDAY) };
			const accepted = await acceptProposal(r.owner, r.head.id, thursday);
			expect(accepted).toMatchObject({
				changed: true,
				proposal: { status: 'superseded', supersededReason: 'sessions_passed' },
				superseded: { reason: 'sessions_passed', href: `/progress/reviews/w-${REVIEWED}` }
			});
			expect((await r.program()).number).toBe(before.number);
			const view = await getWeeklyReviewView(r.owner, REVIEWED, thursday);
			expect(view.decision).toEqual({ state: 'partly_past', proposalId: r.head.id });

			const decided = await decideNextWeek(r.owner, r.review.id, { items: r.all() }, thursday);
			expect(decided).toMatchObject({
				outcome: 'applied',
				versionNumber: before.number + 1,
				passed: 3
			});
			const revision = await proposalRow(
				db,
				decided.outcome === 'applied' ? decided.proposalId : ''
			);
			expect(revision.revision_of).toBe(r.head.id);
			expect(revision.payload.ops).toHaveLength(r.head.payload.ops.length - 3);
			// The superseded head stays as it was.
			expect(await proposalRow(db, r.head.id)).toMatchObject({
				status: 'superseded',
				superseded_reason: 'sessions_passed'
			});
		});
	});

	it('writes nothing when every change has passed', async () => {
		await withRollback(async (db) => {
			const r = await reviewed(db, MONDAY, { monday: true });
			const versions = await versionCount(db, r.owner);
			const sunday = { db, now: at(SUNDAY) };
			const decided = await decideNextWeek(r.owner, r.review.id, { items: r.all() }, sunday);
			expect(decided).toEqual({
				outcome: 'too_late',
				passed: r.adjustments.length,
				words: TOO_LATE
			});
			expect(await versionCount(db, r.owner)).toBe(versions);
			expect(await proposalCount(db, r.owner)).toBe(1);
			expect((await proposalRow(db, r.head.id)).status).toBe('proposed');
		});
	});
});

describe('the same decision from either entry point', () => {
	it('applies an untouched proposal accepted in the inbox as the review would', async () => {
		const appliedVia = async (via: 'inbox' | 'review') => {
			let latest: unknown;
			await withRollback(async (db) => {
				const r = await reviewed(db, MONDAY, { monday: true });
				if (via === 'inbox') await acceptProposal(r.owner, r.head.id, r.deps);
				else await decideNextWeek(r.owner, r.review.id, { items: r.all() }, r.deps);
				const [version] = (await getVersionHistory(r.owner, {}, { db }))!.versions;
				latest = {
					summary: version!.summary,
					createdBy: version!.createdBy,
					decisions: version!.decisions.map((d) => ({
						kind: d.kind,
						ruleKey: d.ruleKey,
						summary: d.summary,
						why: d.why,
						decidedBy: d.decidedBy
					}))
				};
				expect(await proposalRow(db, r.head.id)).toMatchObject({ status: 'applied' });
			});
			return latest;
		};
		const inbox = await appliedVia('inbox');
		expect(inbox).toMatchObject({ createdBy: 'rules' });
		expect(await appliedVia('review')).toEqual(inbox);
	});
});

describe('owner scope', () => {
	it("never decides someone else's review", async () => {
		await withRollback(async (db) => {
			const r = await reviewed(db, TUESDAY);
			const stranger = crypto.randomUUID();
			await expect(
				decideNextWeek(stranger, r.review.id, { items: r.all() }, r.deps)
			).rejects.toBeInstanceOf(ReviewNotFoundError);
			expect((await proposalRow(db, r.head.id)).status).toBe('proposed');
		});
	});
});
