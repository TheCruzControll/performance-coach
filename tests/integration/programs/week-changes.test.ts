/**
 * What a weekly review changed in a week (services/programs/week-changes.ts) on real Postgres,
 * from the week-complete review fixture: the version that applied the review is found for its
 * week after a plain accept, an owner-modified revision and a trimmed late decision, listing only
 * the changes applied; a later edit of the week does not hide it; a week no review changed has
 * none; and it is owner-scoped. Train's load carries it as the notice's words, and its 'first
 * block complete' state leads to the block's cycle review once it exists (block-end).
 * The reviewed week is 9–15 Nov 2026 in Los Angeles; next week is 16–22 Nov.
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { IsoDate } from '../../../src/lib/domain/calendar';
import type { ProgramOp } from '../../../src/lib/domain/coach/proposals';
import type { Executor } from '../../../src/lib/server/db';
import { skipSession, weekChanges } from '../../../src/lib/server/services/programs/index';
import {
	createCycleReview,
	createWeeklyReview,
	decideNextWeek
} from '../../../src/lib/server/services/reviews';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import { loadTrainWeek } from '../../../src/routes/(app)/train/week.server';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const TZ = 'America/Los_Angeles';
const REVIEWED = '2026-11-09';
const NEXT = '2026-11-16';
const MONDAY = '2026-11-16';
const TUESDAY = '2026-11-17';
const THURSDAY = '2026-11-19';
const at = (day: IsoDate) => () => atLocal(day, '12:00', TZ);
const origin = () => ({
	requestId: crypto.randomUUID(),
	method: 'GET',
	path: '/train',
	routeId: '/(app)/train',
	appVersion: '0.1.0+test'
});

type Adjustment = { id: string; sessionDate: IsoDate; halfStep: ProgramOp | null };

/** Add a bench line at a fixed 85 kg on `date`, which the review proposes to raise. */
async function loadLine(db: Executor, owner: string, bench: string, date: IsoDate, at: number) {
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
			values (${rows[0]!.id}, ${at}, 'working', 3, 5, 5, 8, 'absolute', 85, 'kg', 150)`
	);
}

/** The owner's program, its current version and the lineages of the reviewed and next weeks. */
async function current(db: Executor, owner: string) {
	const { rows } = await db.execute<{
		program_id: string;
		number: number;
		reviewed: string;
		next: string;
	}>(
		sql`select p.id::text as program_id, v.number,
				(select w.lineage_id::text from program_weeks w join program_version_weeks vw
					on vw.week_id = w.id where vw.version_id = v.id and w.starts_on = ${REVIEWED}) as reviewed,
				(select w.lineage_id::text from program_weeks w join program_version_weeks vw
					on vw.week_id = w.id where vw.version_id = v.id and w.starts_on = ${NEXT}) as next
			from programs p join program_versions v on v.id = p.current_version_id
			where p.owner_id = ${owner}`
	);
	return rows[0]!;
}

/** week-complete reviewed on `day`, with bench lines the review raises (Monday's too). */
async function reviewed(db: Executor, day: IsoDate, { monday = false } = {}) {
	const owner = await makeOwner(db);
	const deps = { db, now: at(day) };
	const seeded = (await seedAnalyticsFixture(
		owner,
		'week-complete',
		{ timeZone: TZ, now: deps.now() },
		{ db }
	)) as unknown as { exercises: Record<string, string> };
	const bench = seeded.exercises.bench_press!;
	await loadLine(db, owner, bench, THURSDAY, 2);
	if (monday) for (const position of [2, 3, 4]) await loadLine(db, owner, bench, MONDAY, position);
	const { review } = await createWeeklyReview(owner, { weekStartsOn: REVIEWED, today: day }, deps);
	const { rows } = await db.execute<{ evidence: { adjustments: Adjustment[] } }>(
		sql`select evidence from coach_proposals where id = ${review.proposalId}`
	);
	const adjustments = rows[0]!.evidence.adjustments;
	const all = adjustments.map(({ id }) => ({ id, choice: 'proposed' as const }));
	return { owner, deps, review, adjustments, all };
}

/** weekChanges for `week` ('next' or 'reviewed') at the owner's current version. */
async function changesOf(db: Executor, owner: string, week: 'next' | 'reviewed', as = owner) {
	const c = await current(db, owner);
	return weekChanges(
		as,
		{ programId: c.program_id, version: c.number, weekLineage: c[week] },
		{ db }
	);
}

describe('what a weekly review changed in a week', () => {
	it('is found after a plain accept, with each change and its why', async () => {
		await withRollback(async (db) => {
			const r = await reviewed(db, TUESDAY);
			expect(await changesOf(db, r.owner, 'next')).toBeNull();
			const before = await current(db, r.owner);
			const decided = await decideNextWeek(r.owner, r.review.id, { items: r.all }, r.deps);
			expect(decided).toMatchObject({ outcome: 'applied' });

			const found = await changesOf(db, r.owner, 'next');
			expect(found).toMatchObject({
				version: { number: before.number + 1, createdBy: 'rules' },
				applied:
					'The programming rules applied 2 changes from your weekly review of 9 Nov. Each change says why in its own decision.',
				review: { weekStartsOn: REVIEWED }
			});
			expect(found!.changes).toHaveLength(2);
			for (const change of found!.changes) {
				expect(change.summary).not.toBe('');
				expect(change.why).toMatch(/^The programming rules /);
			}
			// The reviewed week itself was not changed.
			expect(await changesOf(db, r.owner, 'reviewed')).toBeNull();
		});
	});

	it('lists only the applied change of an owner-modified revision', async () => {
		await withRollback(async (db) => {
			const r = await reviewed(db, TUESDAY);
			const set = r.adjustments.find((a) => a.halfStep !== null)!;
			const items = [{ id: set.id, choice: 'half_step' as const }];
			await decideNextWeek(r.owner, r.review.id, { items }, r.deps);

			const found = await changesOf(db, r.owner, 'next');
			expect(found).toMatchObject({
				version: { createdBy: 'owner' },
				review: { weekStartsOn: REVIEWED }
			});
			expect(found!.applied).toMatch(/^You applied 1 change from your weekly review of 9 Nov/);
			expect(found!.changes).toHaveLength(1);
			expect(found!.changes[0]!.why).toMatch(/^You /);
		});
	});

	it('is found after a trimmed late decision, listing only the changes still ahead', async () => {
		await withRollback(async (db) => {
			const r = await reviewed(db, MONDAY, { monday: true });
			const thursday = { db, now: at(THURSDAY) };
			const decided = await decideNextWeek(r.owner, r.review.id, { items: r.all }, thursday);
			expect(decided).toMatchObject({ outcome: 'applied', passed: 3 });
			const rest = r.adjustments.filter((a) => a.sessionDate !== MONDAY).length;

			const found = await changesOf(db, r.owner, 'next');
			expect(found!.changes).toHaveLength(rest);
			expect(found!.applied).toContain('3 changes were for sessions already past, so left out.');
			expect(found!.review).toEqual({ weekStartsOn: REVIEWED });
		});
	});

	it('stays after a later edit of the week, naming the version that applied the review', async () => {
		await withRollback(async (db) => {
			const r = await reviewed(db, TUESDAY);
			await decideNextWeek(r.owner, r.review.id, { items: r.all }, r.deps);
			const applied = await current(db, r.owner);
			const { rows } = await db.execute<{ lineage: string }>(
				sql`select ps.lineage_id::text as lineage from planned_sessions ps
					join program_version_weeks vw on vw.week_id = ps.week_id
					join programs p on p.current_version_id = vw.version_id
					where p.owner_id = ${r.owner} and ps.scheduled_on > ${THURSDAY}
					order by ps.scheduled_on limit 1`
			);
			await skipSession(
				r.owner,
				{ sessionLineage: rows[0]!.lineage, reason: 'Away' },
				{ version: applied.number, today: TUESDAY },
				{ db }
			);
			expect((await current(db, r.owner)).number).toBe(applied.number + 1);
			expect(await changesOf(db, r.owner, 'next')).toMatchObject({
				version: { number: applied.number }
			});
		});
	});

	it('is owner-scoped', async () => {
		await withRollback(async (db) => {
			const r = await reviewed(db, TUESDAY);
			await decideNextWeek(r.owner, r.review.id, { items: r.all }, r.deps);
			// The app has one owner; another owner's id reads nothing of this one's.
			expect(await changesOf(db, r.owner, 'next')).not.toBeNull();
			expect(await changesOf(db, r.owner, 'next', crypto.randomUUID())).toBeNull();
		});
	});

	it("reaches Train's load as the notice's words, and only for the week it changed", async () => {
		await withRollback(async (db) => {
			const r = await reviewed(db, TUESDAY);
			await decideNextWeek(r.owner, r.review.id, { items: r.all }, r.deps);
			const { number } = await current(db, r.owner);
			const now = r.deps.now();
			const shown = await loadTrainWeek(r.owner, { now, week: null, origin: origin() }, { db });
			if (shown.state !== 'program') throw new Error(`expected a program, got ${shown.state}`);
			expect(shown.week.startsOn).toBe(NEXT);
			const notice = shown.aside.find((panel) => panel.id === 'review-notice');
			expect(notice).toMatchObject({
				title: 'Updated from your weekly review',
				eyebrow: `Version ${number}`,
				lead: 'The programming rules applied 2 changes from your weekly review of 9 Nov. Each change says why in its own decision.'
			});
			expect(notice!.points).toHaveLength(2);
			for (const point of notice!.points) expect(point.text).toMatch(/^The programming rules /);
			expect(notice!.links).toEqual([
				{
					id: 'review-notice-version',
					href: `/train/history/${number}`,
					label: 'See it in History'
				},
				{
					id: 'review-notice-review',
					href: `/progress/reviews/w-${REVIEWED}`,
					label: 'Open your weekly review'
				}
			]);

			const week = String(Number(shown.shown) - 1);
			const before = await loadTrainWeek(r.owner, { now, week, origin: origin() }, { db });
			expect(before.state === 'program' && before.week.startsOn).toBe(REVIEWED);
			expect(before.state === 'program' && before.aside).toEqual([]);
		});
	});
});

describe("Train's first block complete", () => {
	it('leads to the reviews list until the block has a cycle review, then to that review', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			// block-end: the block is 26 Oct – 22 Nov, every session logged by Wednesday 18 Nov.
			const seeded = (await seedAnalyticsFixture(
				owner,
				'block-end',
				{ timeZone: TZ, now: at('2026-11-18')() },
				{ db }
			)) as unknown as { programId: string };
			const after = { now: at('2026-11-24')(), week: null, origin: origin() };
			const card = async () => {
				const data = await loadTrainWeek(owner, { ...after, origin: origin() }, { db });
				return data.state === 'program' ? data.card : null;
			};
			expect(await card()).toMatchObject({
				id: 'train-block-complete',
				next: { title: 'Review this block', to: { href: '/progress/reviews' } }
			});

			const { rows } = await db.execute<{ lineage: string }>(
				sql`select b.lineage_id::text as lineage from programs p
					join program_version_blocks vb on vb.version_id = p.current_version_id
					join program_blocks b on b.id = vb.block_id
					where p.owner_id = ${owner} and not b.outline order by b.starts_on desc limit 1`
			);
			const target = { programId: seeded.programId, blockLineage: rows[0]!.lineage };
			const deps = { db, now: at('2026-11-18') };
			const { review } = await createCycleReview(owner, { ...target, today: '2026-11-18' }, deps);
			expect(await card()).toMatchObject({
				id: 'train-block-complete',
				next: { title: 'Open your cycle review', to: { href: `/progress/reviews/c-${review.id}` } }
			});
		});
	});
});
