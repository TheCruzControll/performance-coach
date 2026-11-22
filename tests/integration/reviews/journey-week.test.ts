/**
 * The weekly journey's fixture (src/lib/server/test-support/analytics-fixtures/journey-week.ts)
 * on real Postgres, on every weekday the browser journey may run: today's evening easy run is
 * the one session left to log, so the week is not reviewable yet (Today offers last week); once
 * it is logged, this week is reviewable early, and its review proposes bench +2.5 kg with a half
 * step on next week's Monday and Thursday, every change still ahead (the card open).
 * Los Angeles; the dates are Monday 16 Nov 2026 to Sunday 22 Nov, each seeded at noon.
 */
import { describe, expect, it } from 'vitest';
import { addDays, mondayOf, type IsoDate } from '../../../src/lib/domain/calendar';
import type { Executor } from '../../../src/lib/server/db';
import { getProgramVersion } from '../../../src/lib/server/services/programs/index';
import {
	createWeeklyReview,
	getWeeklyReviewView,
	nextWeekOffers,
	reviewableWeek
} from '../../../src/lib/server/services/reviews';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import {
	logSession,
	type Key,
	type ReviewFixtureResult
} from '../../../src/lib/server/test-support/analytics-fixtures/reviews';
import { weeklyReviewData } from '../../../src/routes/(app)/progress/reviews/[[key]]/load';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';

const TZ = 'America/Los_Angeles';
const DAYS = ['16', '17', '18', '19', '20', '21', '22'].map((d) => `2026-11-${d}` as IsoDate);

type Seeded = ReviewFixtureResult & { programId: string };

async function seed(db: Executor, day: IsoDate) {
	const owner = await makeOwner(db);
	const now = atLocal(day, '12:00', TZ);
	const seeded = (await seedAnalyticsFixture(
		owner,
		'journey-week',
		{ timeZone: TZ, now },
		{ db }
	)) as unknown as Seeded;
	return { owner, now, seeded, deps: { db, now: () => now } };
}

describe('journey-week, on every weekday', () => {
	it('leaves today’s evening run to log; once logged, this week’s review proposes bench +2.5 kg with a half step on both days', async () => {
		for (const day of DAYS) {
			await withRollback(async (db) => {
				const { owner, now, seeded, deps } = await seed(db, day);
				if (seeded.review.kind !== 'weekly') throw new Error('A weekly scenario');
				const { weekStartsOn, nextWeekStartsOn } = seeded.review;
				const thisWeek = mondayOf(day);
				expect(weekStartsOn, day).toBe(thisWeek);

				const version = await getProgramVersion(owner, seeded.programId, 1, { db });
				const weeks = version.blocks.flatMap((b) => b.weeks);
				const w = weeks.findIndex((week) => week.startsOn === thisWeek);
				const pending = weeks[w]!.sessions.find((s) => s.lineage === seeded.lineages.pending);
				expect(pending, `${day}: a session left to log`).toMatchObject({
					date: day,
					type: 'easy_run',
					timeOfDay: 'evening'
				});
				expect(weeks[w + 1]?.startsOn, `${day}: next week is planned`).toBe(nextWeekStartsOn);
				// Not done yet: Today offers last week.
				expect(await reviewableWeek(owner, day, deps), day).toEqual({
					weekStartsOn: addDays(thisWeek, -7),
					reason: 'ended'
				});

				const ctx = { ownerId: owner, timeZone: TZ, now, today: day, weekStart: thisWeek, db };
				const ids = seeded.exercises as Record<Key, string>;
				await logSession(ctx, ids, pending!, w, false);
				expect(await reviewableWeek(owner, day, deps), day).toEqual({
					weekStartsOn: thisWeek,
					reason: 'all_done'
				});

				await createWeeklyReview(owner, { weekStartsOn, today: day }, deps);
				const view = await getWeeklyReviewView(owner, weekStartsOn, deps);
				expect(view.proposal, `${day}: the review proposes`).not.toBeNull();
				const offers = await nextWeekOffers(owner, view.proposal!.id, day, deps);
				const card = weeklyReviewData(view, offers, day).nextWeek!;
				expect(card.state, day).toBe('open');
				expect(
					offers.every((o) => o.ahead),
					day
				).toBe(true);
				for (const date of [nextWeekStartsOn, addDays(nextWeekStartsOn, 3)]) {
					const offer = offers.find((o) => o.sessionDate === date && o.id.includes('load'));
					const bench = card.items.find((i) => i.id === offer?.id);
					expect(bench, `${day}: bench on ${date}`).toMatchObject({ half: '86.25 kg' });
					expect(bench!.after, day).toContain('87.5 kg');
				}
			});
		}
	});
});
