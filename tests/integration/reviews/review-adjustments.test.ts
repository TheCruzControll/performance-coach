/**
 * The review screen's next-week card on real Postgres (M6 review-adjustments-ui): the
 * review-ahead and review-aged fixtures, nextWeekOffers' split of a head's changes on the owner's
 * today as the card shows it (load.ts nextWeekView), and the decide and keep form actions
 * (forms/reviews.ts) through decideNextWeek, with what each failure maps to.
 * Los Angeles; the dates are Monday 16 Nov 2026 to Sunday 22 Nov.
 */
import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { addDays, type IsoDate } from '../../../src/lib/domain/calendar';
import type { Executor } from '../../../src/lib/server/db';
import { decideReview } from '../../../src/lib/server/forms/reviews';
import {
	getWeeklyReviewView,
	nextWeekOffers,
	refreshWeeklyReview
} from '../../../src/lib/server/services/reviews';
import { editSet } from '../../../src/lib/server/services/training/log';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import { weeklyReviewData } from '../../../src/routes/(app)/progress/reviews/[[key]]/load';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const TZ = 'America/Los_Angeles';
const MONDAY = '2026-11-16';
const THURSDAY = '2026-11-19';
const SATURDAY = '2026-11-21';
const WEDNESDAY = '2026-11-18';

interface Seeded {
	review: { weekStartsOn: IsoDate; nextWeekStartsOn: IsoDate };
	lineages: Record<string, string>;
	programId: string;
}

async function seed(db: Executor, fixture: 'review-ahead' | 'review-aged', day: IsoDate) {
	const owner = await makeOwner(db);
	const now = atLocal(day, '12:00', TZ);
	const seeded = (await seedAnalyticsFixture(
		owner,
		fixture,
		{ timeZone: TZ, now },
		{ db }
	)) as unknown as Seeded;
	const deps = { db, now: () => now };
	const view = () => getWeeklyReviewView(owner, seeded.review.weekStartsOn, deps);
	const first = await view();
	return { owner, seeded, deps, view, first, day };
}

/** The card as the screen would show it on `day`. */
async function card(s: Awaited<ReturnType<typeof seed>>) {
	const view = await s.view();
	const offers = view.proposal
		? await nextWeekOffers(s.owner, view.proposal.id, s.day, s.deps)
		: [];
	return { offers, card: weeklyReviewData(view, offers, s.day).nextWeek! };
}

const benchOn = <T extends { id: string; sessionDate: IsoDate | null }>(
	offers: T[],
	date: IsoDate
) => offers.find((o) => o.sessionDate === date && o.id.includes('load'));

const versions = async (db: Executor, owner: string) =>
	(
		await db.execute<{ n: number }>(
			sql`select count(*)::int as n from program_versions v join programs p on p.id = v.program_id
				where p.owner_id = ${owner}`
		)
	).rows[0]!.n;

function form(fields: [string, string][]): FormData {
	const data = new FormData();
	for (const [k, v] of fields) data.append(k, v);
	return data;
}

describe('review-aged: a review stored on Monday, decided later in the week', () => {
	it('on Thursday strikes through Monday’s change and keeps Thursday’s open', async () => {
		await withRollback(async (db) => {
			const s = await seed(db, 'review-aged', THURSDAY);
			expect(s.seeded.review.nextWeekStartsOn).toBe(MONDAY);
			expect(s.first.decision.state).toBe('undecided');
			const { offers, card: shown } = await card(s);
			expect(benchOn(offers, MONDAY)).toMatchObject({ ahead: false });
			expect(benchOn(offers, THURSDAY)).toMatchObject({ ahead: true });
			expect(benchOn(offers, THURSDAY)!.halfStep).toMatchObject({ loadValue: 86.25 });

			expect(shown.state).toBe('partly_past');
			expect(shown.title).toBe('Some sessions have passed — apply the rest?');
			const monday = shown.items.find((i) => i.id === benchOn(offers, MONDAY)!.id)!;
			const thursday = shown.items.find((i) => i.id === benchOn(offers, THURSDAY)!.id)!;
			expect(monday.passed).toBe('Monday has passed');
			expect(thursday).toMatchObject({ passed: null, half: '86.25 kg' });
			expect(thursday.after).toContain('87.5 kg');
			const left = offers.filter((o) => o.ahead).length;
			expect(shown.words).toBe(`${left} of ${offers.length} changes are still ahead.`);
		});
	});

	it('on Monday drops the change for today’s session once it is logged', async () => {
		await withRollback(async (db) => {
			const s = await seed(db, 'review-aged', MONDAY);
			const { offers, card: shown } = await card(s);
			expect(benchOn(offers, MONDAY)).toMatchObject({ ahead: false });
			expect(benchOn(offers, THURSDAY)).toMatchObject({ ahead: true });
			const monday = shown.items.find((i) => i.id === benchOn(offers, MONDAY)!.id)!;
			expect(monday.passed).toBe('Monday’s session has started');
		});
	});

	it('on Saturday reads too late, and Generate writes nothing', async () => {
		await withRollback(async (db) => {
			const s = await seed(db, 'review-aged', SATURDAY);
			const { offers, card: shown } = await card(s);
			expect(offers.every((o) => !o.ahead)).toBe(true);
			expect(shown).toMatchObject({ state: 'all_past', title: 'Too late to change next week' });
			const before = await versions(db, s.owner);
			const result = await decideReview(
				s.owner,
				{
					form: form([
						['reviewId', s.first.review.id],
						...offers.map((o): [string, string] => ['item', o.id])
					]),
					mode: 'decide',
					weekStartsOn: s.seeded.review.weekStartsOn
				},
				s.deps
			);
			expect(result).toEqual({ outcome: 'too_late' });
			expect(await versions(db, s.owner)).toBe(before);
		});
	});

	it('on Thursday Generate applies only the rest and says how many had passed', async () => {
		await withRollback(async (db) => {
			const s = await seed(db, 'review-aged', THURSDAY);
			const { offers } = await card(s);
			const passed = offers.filter((o) => !o.ahead).length;
			const before = await versions(db, s.owner);
			const result = await decideReview(
				s.owner,
				{
					form: form([
						['reviewId', s.first.review.id],
						...offers.map((o): [string, string] => ['item', o.id])
					]),
					mode: 'decide',
					weekStartsOn: s.seeded.review.weekStartsOn
				},
				s.deps
			);
			expect(passed).toBeGreaterThan(0);
			expect(result).toEqual({
				outcome: 'applied',
				words: `Next week updated · version ${before + 1} · ${passed} ${passed === 1 ? 'change was' : 'changes were'} for sessions already past`,
				href: '/train?week=4'
			});
			const after = await card(s);
			expect(after.card.state).toBe('applied');
			expect(after.card.link).toEqual({
				href: `/train/history/${before + 1}`,
				label: `See version ${before + 1} in History`
			});
			const [applied] = (
				await db.execute<{ n: number }>(
					sql`select jsonb_array_length(payload->'ops')::int as n from coach_proposals
						where owner_id = ${s.owner} and status = 'applied'`
				)
			).rows;
			expect(applied!.n).toBe(offers.length - passed);
		});
	});
});

describe('review-ahead: every change still ahead', () => {
	it('takes one change at its half step, leaves the rest out, and reads applied', async () => {
		await withRollback(async (db) => {
			const s = await seed(db, 'review-ahead', WEDNESDAY);
			const next = s.seeded.review.nextWeekStartsOn;
			expect(next).toBe('2026-11-23');
			const { offers, card: shown } = await card(s);
			expect(shown.state).toBe('open');
			expect(offers.every((o) => o.ahead)).toBe(true);
			const thursday = benchOn(offers, '2026-11-26')!;
			expect(thursday.halfStep).toMatchObject({ loadValue: 86.25 });

			const result = await decideReview(
				s.owner,
				{
					form: form([
						['reviewId', s.first.review.id],
						['item', thursday.id],
						[`choice:${thursday.id}`, 'half_step']
					]),
					mode: 'decide',
					weekStartsOn: s.seeded.review.weekStartsOn
				},
				s.deps
			);
			expect(result).toMatchObject({ outcome: 'applied', href: '/train?week=4' });
			const applied = await card(s);
			expect(applied.card.state).toBe('applied');
			const { rows } = await db.execute<{ ops: { loadValue?: number }[] }>(
				sql`select payload->'ops' as ops from coach_proposals
					where owner_id = ${s.owner} and status = 'applied'`
			);
			expect(rows).toEqual([{ ops: [expect.objectContaining({ loadValue: 86.25 })] }]);
		});
	});

	it('keeps next week as planned with the reason, and writes no version', async () => {
		await withRollback(async (db) => {
			const s = await seed(db, 'review-ahead', WEDNESDAY);
			const before = await versions(db, s.owner);
			const result = await decideReview(
				s.owner,
				{
					form: form([
						['reviewId', s.first.review.id],
						['item', 'ignored by keep'],
						['note', '  A race this weekend  ']
					]),
					mode: 'keep',
					weekStartsOn: s.seeded.review.weekStartsOn
				},
				s.deps
			);
			expect(result).toEqual({ outcome: 'rejected' });
			expect(await versions(db, s.owner)).toBe(before);
			const kept = await card(s);
			expect(kept.card).toMatchObject({
				state: 'rejected',
				title: 'Kept as planned',
				words: 'A race this weekend'
			});
		});
	});

	it('Keep on a review already applied (another tab) just reloads the card: no toast, no Train', async () => {
		await withRollback(async (db) => {
			const s = await seed(db, 'review-ahead', WEDNESDAY);
			const { offers } = await card(s);
			const post = (mode: 'decide' | 'keep') =>
				decideReview(
					s.owner,
					{
						form: form([
							['reviewId', s.first.review.id],
							...offers.map((o): [string, string] => ['item', o.id])
						]),
						mode,
						weekStartsOn: s.seeded.review.weekStartsOn
					},
					s.deps
				);
			expect(await post('decide')).toMatchObject({ outcome: 'applied', href: '/train?week=4' });
			expect(await post('keep')).toEqual({ outcome: 'applied' });
		});
	});

	it('refuses Generate with nothing ticked, and writes nothing', async () => {
		await withRollback(async (db) => {
			const s = await seed(db, 'review-ahead', WEDNESDAY);
			const result = await decideReview(
				s.owner,
				{
					form: form([['reviewId', s.first.review.id]]),
					mode: 'decide',
					weekStartsOn: s.seeded.review.weekStartsOn
				},
				s.deps
			);
			expect(result).toMatchObject({
				status: 400,
				data: {
					reason: 'invalid',
					message: 'Tick at least one change, or keep next week as planned.'
				}
			});
			expect((await s.view()).decision.state).toBe('undecided');
		});
	});

	it('maps an unknown change to 400, an unknown review to 404 and a refreshed one to 409', async () => {
		await withRollback(async (db) => {
			const s = await seed(db, 'review-ahead', WEDNESDAY);
			const week = s.seeded.review.weekStartsOn;
			const post = (fields: [string, string][]) =>
				decideReview(s.owner, { form: form(fields), mode: 'decide', weekStartsOn: week }, s.deps);

			expect(
				await post([
					['reviewId', s.first.review.id],
					['item', 'nope']
				])
			).toMatchObject({
				status: 400,
				data: { reason: 'invalid', message: 'That change is not in this review' }
			});
			expect(
				await post([
					['reviewId', crypto.randomUUID()],
					['item', 'x']
				])
			).toMatchObject({
				status: 404,
				data: { reason: 'not_found' }
			});
			// A set of the reviewed week edited makes it stale; Refresh writes its next revision.
			const { rows } = await db.execute<{ id: string; weight: string }>(
				sql`select r.client_mutation_id::text as id, r.weight from set_records r
					where r.owner_id = ${s.owner} and r.deleted_at is null
					order by r.performed_at desc limit 1`
			);
			const edited = {
				...{ weight: Number(rows[0]!.weight), assistance: null, unit: 'kg', reps: 5 },
				...{ missedReps: 0, seconds: null, metres: null, rpe: 9.5 },
				...{ isWarmup: false, isExtra: false, isSkipped: false }
			};
			await editSet(s.owner, rows[0]!.id, edited, { db });
			await refreshWeeklyReview(s.owner, s.first.review.id, { today: WEDNESDAY }, s.deps);
			expect(
				await post([
					['reviewId', s.first.review.id],
					['item', 'x']
				])
			).toMatchObject({
				status: 409,
				data: { reason: 'refreshed' }
			});
		});
	});
});

describe('on every weekday, as the specs rely on', () => {
	const DAYS = ['16', '17', '18', '19', '20', '21', '22'].map((d) => `2026-11-${d}` as IsoDate);

	it('review-ahead: every change ahead, bench +2.5 kg with its half step on both days', async () => {
		for (const day of DAYS) {
			await withRollback(async (db) => {
				const s = await seed(db, 'review-ahead', day);
				const { offers, card: shown } = await card(s);
				const next = s.seeded.review.nextWeekStartsOn;
				expect(shown.state, day).toBe('open');
				expect(
					offers.every((o) => o.ahead),
					day
				).toBe(true);
				for (const date of [next, addDays(next, 3)]) {
					const bench = shown.items.find((i) => i.id === benchOn(offers, date)?.id);
					expect(bench, `${day}: bench on ${date}`).toMatchObject({ half: '86.25 kg' });
					expect(bench!.after, day).toContain('87.5 kg');
				}
			});
		}
	});

	it('review-aged: at least one change has passed or started; every one from Saturday', async () => {
		for (const day of DAYS) {
			await withRollback(async (db) => {
				const s = await seed(db, 'review-aged', day);
				const { offers, card: shown } = await card(s);
				const passed = offers.filter((o) => !o.ahead).length;
				expect(passed, day).toBeGreaterThan(0);
				expect(shown.state, day).toBe(day >= SATURDAY ? 'all_past' : 'partly_past');
			});
		}
	});
});
