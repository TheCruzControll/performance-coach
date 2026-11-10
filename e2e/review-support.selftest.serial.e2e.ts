/**
 * The review specs' support (e2e/review-support.ts) and the reviews oracle (e2e/oracles/reviews.ts)
 * against the real server: week-complete is seeded through the test-only route, then a weekly
 * review in two revisions and a proposal chain of three are written here by hand in SQL, and the
 * oracle must read back exactly those rows, the chain's head from any link, and the version
 * with its author and decisions.
 *
 * Serial: the history is the one owner's, which every browser and worker shares.
 */
import { expect, test } from '@playwright/test';
import { addDays } from '../src/lib/domain/calendar';
import { programVersions, proposalChain, weeklyReviews } from './oracles/reviews';
import { ANALYTICS_TZ, query, resetReviews, seedReview, type SeededReview } from './review-support';

test.use({ timezoneId: ANALYTICS_TZ });
test.describe.configure({ mode: 'serial' });

let seeded: SeededReview;

test.beforeAll(async ({ request }) => {
	seeded = await seedReview(request, 'week-complete');
});

test.afterAll(async ({ request }) => {
	await resetReviews(request);
});

test('the route seeds week-complete: last week to review, this week next', async () => {
	expect(seeded).toMatchObject({ fixture: 'week-complete', timeZone: ANALYTICS_TZ });
	expect(seeded.review).toEqual({
		kind: 'weekly',
		weekStartsOn: addDays(seeded.weekStart, -7),
		nextWeekStartsOn: seeded.weekStart
	});
	expect(Object.keys(seeded.workouts).sort()).toEqual(['longRun', 'sparring']);
	const [{ n }] = (await query<{ n: number }>(`select count(*)::int as n from weekly_reviews`)) as [
		{ n: number }
	];
	expect(n).toBe(0);
});

test('the oracle reads back hand-written review revisions, a proposal chain and the version', async () => {
	const programId = seeded.programId!;
	const [{ owner, version }] = (await query<{ owner: string; version: string }>(
		`select owner_id::text as owner, current_version_id::text as version from programs where id = $1`,
		[programId]
	)) as [{ owner: string; version: string }];
	const week = seeded.review.kind === 'weekly' ? seeded.review.weekStartsOn : '';
	const [p1, p2, p3, r1, r2] = Array.from({ length: 5 }, () => crypto.randomUUID());

	// Three proposals, each revising the last; the first two superseded, the head applied.
	const proposal = (id: string, revisionOf: string | null) =>
		query(
			`insert into coach_proposals (id, owner_id, kind, title, summary, rationale, payload,
				program_id, base_version_id, revision_of)
			values ($1, $2, 'program_adjustment', 'Next week', 'Bench stays', 'Bench felt light', '{}',
				$3, $4, $5)`,
			[id, owner, programId, version, revisionOf]
		);
	const supersede = (id: string) =>
		query(
			`update coach_proposals set status = 'superseded', superseded_reason = 'revised' where id = $1`,
			[id]
		);
	await proposal(p1!, null);
	await proposal(p2!, p1!);
	await supersede(p1!);
	await proposal(p3!, p2!);
	await supersede(p2!);
	await query(
		`update coach_proposals set status = 'applied', applied_version_id = $2 where id = $1`,
		[p3, version]
	);

	// A review, then its refresh: the first marked superseded by the second, in one transaction.
	const review = (id: string, revision: number, summary: string) =>
		`insert into weekly_reviews (id, owner_id, week_starts_on, snapshot, summary, program_id,
			version_id, snapshot_version, analytics_version, inputs_digest, revision, proposal_id)
		values ('${id}', '${owner}', '${week}', '{}', '${summary}', '${programId}', '${version}', 1, 1,
			'digest-${revision}', ${revision}, '${p1}')`;
	await query(review(r1!, 1, 'A solid week'));
	await query(`begin;
		update weekly_reviews set superseded_at = now(), superseded_by = '${r2}' where id = '${r1}';
		${review(r2!, 2, 'A solid week, the bench light')};
		commit`);

	const row = { proposalId: p1, versionNumber: 1, snapshotVersion: 1, analyticsVersion: 1 };
	expect(await weeklyReviews(week)).toEqual([
		{
			id: r1,
			revision: 1,
			live: false,
			supersededBy: r2,
			summary: 'A solid week',
			narrative: null,
			weekStartsOn: week,
			...row
		},
		{
			id: r2,
			revision: 2,
			live: true,
			supersededBy: null,
			summary: 'A solid week, the bench light',
			narrative: null,
			weekStartsOn: week,
			...row
		}
	]);
	expect(await weeklyReviews(seeded.weekStart)).toEqual([]);

	const links = [
		{
			id: p1,
			revisionOf: null,
			status: 'superseded',
			supersededReason: 'revised',
			appliedVersionNumber: null
		},
		{
			id: p2,
			revisionOf: p1,
			status: 'superseded',
			supersededReason: 'revised',
			appliedVersionNumber: null
		},
		{ id: p3, revisionOf: p2, status: 'applied', supersededReason: null, appliedVersionNumber: 1 }
	];
	for (const from of [p1!, p2!, p3!]) {
		expect(await proposalChain(from), `from ${from}`).toEqual({ chain: links, head: links[2] });
	}

	expect(await programVersions(programId)).toEqual([
		{
			id: version,
			number: 1,
			parentNumber: null,
			createdBy: 'rules',
			summary: 'Your first program',
			generator: expect.stringMatching(/\S/),
			current: true,
			decisions: [
				{
					kind: 'program_purpose',
					ruleKey: 'blocks.default',
					summary: 'Strength, running and Muay Thai together',
					why: 'Review fixture: two lifting days, two runs, the class and sparring.',
					decidedBy: 'rules'
				}
			]
		}
	]);
});
