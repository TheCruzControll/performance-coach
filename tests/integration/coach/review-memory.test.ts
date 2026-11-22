/**
 * Reviews as coach sources and memory (the M6 plan's coach-review-sources), on real Postgres from
 * the review fixtures at a forced today:
 * - the coaching memory lists a week's live review, never a superseded revision, with its
 *   summary, verdicts and the decision read from its proposal chain's head (an owner-modified,
 *   applied revision reads applied), and a source that opens the review's page
 * - a review's pending proposal is marked as the review's (origin weekly_review, with the review
 *   as a source) in memory and in get_coach_proposals
 * - get_weekly_training_summary names the week's review as a source
 * - the mock 'What should I focus on next week?' cites the review, and the mock 'What did you
 *   propose?' attributes the review's proposal to the review, never to the coach
 * Today is Tuesday 17 Nov 2026 in Los Angeles: the reviewed week is 9–15 Nov.
 */
import { sql } from 'drizzle-orm';
import * as z from 'zod/mini';
import { describe, expect, it } from 'vitest';
import { addDays } from '../../../src/lib/domain/calendar';
import type { CoachEvent } from '../../../src/lib/domain/coach/events';
import { sourceAction, type SourceRef } from '../../../src/lib/domain/coach/sources';
import { readSnapshot } from '../../../src/lib/domain/programming/review/snapshot';
import { analyticsScripts } from '../../../src/lib/server/agent/provider/mock-scripts/analytics';
import { programmingReadScripts } from '../../../src/lib/server/agent/provider/mock-scripts/programming-reads';
import { ANALYTICS_TOOLS } from '../../../src/lib/server/agent/tools/analytics';
import { toolContext } from '../../../src/lib/server/agent/tools/context';
import type { CoachTool } from '../../../src/lib/server/agent/tools/define';
import { executeToolCalls } from '../../../src/lib/server/agent/tools/execute';
import { PROGRAMMING_READ_TOOLS } from '../../../src/lib/server/agent/tools/programming-reads';
import type { Executor } from '../../../src/lib/server/db';
import { getCoachingMemory } from '../../../src/lib/server/services/coach/memory';
import { acceptProposal, createProposal } from '../../../src/lib/server/services/coach/proposals';
import { toolRuntime, type ResolvedCoachDeps } from '../../../src/lib/server/services/coach/shared';
import {
	createWeeklyReview,
	getWeeklyReview,
	refreshWeeklyReview
} from '../../../src/lib/server/services/reviews';
import { finishWorkout, logSet, startWorkout } from '../../../src/lib/server/services/training/log';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import type { ReviewFixtureResult } from '../../../src/lib/server/test-support/analytics-fixtures/reviews';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';
import { runScripted, segmentIssues } from './harness';

const TZ = 'America/Los_Angeles';
const TODAY = '2026-11-17';
const THIS_WEEK = '2026-11-16';
const REVIEWED = '2026-11-09';
const NOW = atLocal(TODAY, '12:00', TZ);
const now = () => NOW;
const REVIEW_REF = { type: 'review', id: `w-${REVIEWED}` } as const;

type Seeded = ReviewFixtureResult & { exercises: Record<string, string> };
type Tools = readonly CoachTool<ResolvedCoachDeps>[];
const TOOLS = [...PROGRAMMING_READ_TOOLS, ...ANALYTICS_TOOLS] as Tools;

async function seed(db: Executor, fixture = 'week-complete') {
	const owner = await makeOwner(db);
	const seeded = (await seedAnalyticsFixture(
		owner,
		fixture,
		{ timeZone: TZ, now: NOW },
		{ db }
	)) as unknown as Seeded;
	// M6's checkWeek path (the context reads skipped), so the review holds a proposal: with M7's
	// judge the hard week's next week has no move a finding would not name (m7/24).
	return { owner, seeded, deps: { db, now, context: { reader: async () => null } } };
}

const review = (owner: string, deps: { db: Executor; now: () => Date }, weekStartsOn = REVIEWED) =>
	createWeeklyReview(owner, { weekStartsOn, today: TODAY }, deps);

/** A bench set logged now in an ad hoc workout on the reviewed week's Wednesday: it goes stale. */
async function lateSet(db: Executor, owner: string, benchId: string) {
	const at = atLocal(addDays(REVIEWED, 2), '18:00', TZ);
	const clientId = crypto.randomUUID();
	const workout = { clientId, kind: 'strength', discipline: 'strength', sessionType: 'strength' };
	await startWorkout(
		owner,
		{ ...workout, title: 'Extra bench', plannedSessionId: null, startedAt: at.toISOString() },
		{ db }
	);
	await logSet(
		owner,
		{
			...{ clientMutationId: crypto.randomUUID(), workoutClientId: clientId },
			...{ exerciseId: benchId, plannedExerciseLineageId: null, exercisePosition: 1, setIndex: 1 },
			...{ weight: 60, unit: 'kg', reps: 5, missedReps: 0, rpe: 6, seconds: null, metres: null },
			...{ isExtra: false, isSkipped: false, isWarmup: false },
			performedAt: new Date(at.getTime() + 60_000).toISOString()
		},
		{ db }
	);
	const finishedAt = new Date(at.getTime() + 20 * 60_000).toISOString();
	const done = { status: 'completed', finishedAt, durationSeconds: 1200, sessionRpe: 6 };
	await finishWorkout(owner, clientId, done, { db });
}

/** One tool call as a turn runs it, checked against the tool's output schema. */
async function output<T>(db: Executor, owner: string, name: string, input: object = {}) {
	const ctx = toolContext({
		session: { ownerId: owner },
		message: { threadId: crypto.randomUUID(), runId: crypto.randomUUID(), text: '', entry: null },
		day: { today: TODAY, timeZone: TZ },
		runtime: toolRuntime({ db, now }),
		signal: new AbortController().signal,
		deadlineAt: Date.now() + 60_000,
		matchExercise: () => null
	});
	const { outcomes } = await executeToolCalls([{ id: 'toolu_01Read', name, input }], ctx, {
		tools: TOOLS
	});
	const outcome = outcomes[0]!;
	expect(outcome.error, name).toBeNull();
	const tool = TOOLS.find((each) => each.name === name)!;
	const parsed = z.safeParse(tool.outputSchema, outcome.output);
	expect(parsed.success, `${name}: ${parsed.error?.message ?? ''}`).toBe(true);
	return outcome.output as T;
}

/** The verdict findings of a stored review as memory words them. */
async function verdictsOf(owner: string, id: string, db: Executor) {
	const stored = await getWeeklyReview(owner, id, { db });
	const read = readSnapshot(stored);
	if (read.legacy) throw new Error('expected an M6 review');
	return read.snapshot.brief.findings
		.filter((f) => f.section === 'verdicts')
		.map((f) => `${f.label}: ${f.verdict.words}`);
}

type Block = { kind: string; sources: SourceRef[]; grounded: boolean; raw: string };
const blocksOf = (events: CoachEvent[]): Block[] =>
	events.flatMap((event) =>
		event.type === 'block_completed'
			? [
					{
						kind: event.kind,
						sources: event.sources,
						grounded: event.grounded,
						raw: JSON.stringify(event.ast)
					}
				]
			: []
	);

describe('the coaching memory’s reviews', () => {
	it('lists the live revision of a refreshed review, never the superseded one, with its verdicts and decision', async () => {
		await withRollback(async (db) => {
			const { owner, seeded, deps } = await seed(db);
			const { review: first } = await review(owner, deps);
			await lateSet(db, owner, seeded.exercises.bench_press!);
			const second = await refreshWeeklyReview(owner, first.id, { today: TODAY }, deps);
			expect(second.revision).toBe(2);

			const memory = await getCoachingMemory(owner, { today: TODAY }, { db });
			const weeks = memory.records.reviews.filter((r) => r.date === REVIEWED);
			const verdicts = await verdictsOf(owner, second.id, db);
			expect(verdicts.length).toBeGreaterThan(0);
			expect(weeks).toEqual([
				{
					scope: 'week',
					date: REVIEWED,
					summary: second.summary,
					verdicts,
					// The refreshed revision's own proposal, not the superseded one's.
					decisionState: 'undecided',
					source: { ...REVIEW_REF, date: REVIEWED }
				}
			]);
			expect(sourceAction(weeks[0]!.source)).toEqual({
				kind: 'link',
				href: `/progress/reviews/w-${REVIEWED}`
			});
		});
	});

	it('reads an owner-modified revision of the review’s proposal, once applied, as applied', async () => {
		await withRollback(async (db) => {
			const { owner, deps } = await seed(db);
			const { review: stored } = await review(owner, deps);
			const { rows } = await db.execute<{ title: string; payload: { ops: object[] } }>(
				sql`select title, payload from coach_proposals where id = ${stored.proposalId}`
			);
			const [move] = rows[0]!.payload.ops;
			const { proposal: revision } = await createProposal(
				owner,
				{
					proposal: {
						kind: 'program_adjustment',
						title: rows[0]!.title,
						rationale: 'Saturday suits me better',
						payload: { ops: [{ ...move, toDate: '2026-11-22' }] }
					},
					revises: stored.proposalId,
					provenance: {
						kind: 'weekly_review',
						reviewId: stored.id,
						revision: 1,
						weekStartsOn: REVIEWED,
						modifiedBy: 'owner'
					}
				},
				deps
			);
			const accepted = await acceptProposal(owner, revision.id, deps);
			expect(accepted.proposal.status).toBe('applied');

			const memory = await getCoachingMemory(owner, { today: TODAY }, { db });
			expect(memory.records.reviews.find((r) => r.date === REVIEWED)).toMatchObject({
				decisionState: 'applied'
			});
			// The applied revision is still the review's, not the coach's.
			expect(memory.records.proposals.find((p) => p.source.id === revision.id)).toMatchObject({
				status: 'applied',
				origin: 'weekly_review',
				review: REVIEW_REF
			});
		});
	});
});

describe('a review’s proposal, marked as the review’s', () => {
	it('appears pending in memory and in get_coach_proposals with origin weekly_review and the review link', async () => {
		await withRollback(async (db) => {
			const { owner, deps } = await seed(db);
			const { review: stored } = await review(owner, deps);
			const proposalId = stored.proposalId!;

			const memory = await getCoachingMemory(owner, { today: TODAY }, { db });
			expect(memory.records.proposals.find((p) => p.source.id === proposalId)).toMatchObject({
				status: 'proposed',
				origin: 'weekly_review',
				review: REVIEW_REF
			});

			type Out = { items: { source: SourceRef; origin: string; review: SourceRef | null }[] };
			const listed = await output<Out>(db, owner, 'get_coach_proposals', { status: 'proposed' });
			const item = listed.items.find((p) => p.source.id === proposalId)!;
			expect(item.origin).toBe('weekly_review');
			expect(item.review).toEqual({ ...REVIEW_REF, label: 'Weekly review' });
			expect(sourceAction(item.review!)).toEqual({
				kind: 'link',
				href: `/progress/reviews/w-${REVIEWED}`
			});
		});
	});

	it('get_weekly_training_summary names the week’s review as a source, and none for a week not reviewed', async () => {
		await withRollback(async (db) => {
			const { owner, deps } = await seed(db);
			type Out = { status: string; review: SourceRef | null };
			const before = await output<Out>(db, owner, 'get_weekly_training_summary', {
				week: REVIEWED
			});
			expect(before).toMatchObject({ status: 'ok', review: null });

			await review(owner, deps);
			const after = await output<Out>(db, owner, 'get_weekly_training_summary', {
				week: REVIEWED
			});
			expect(after.review).toEqual({ ...REVIEW_REF, label: 'Weekly review', date: REVIEWED });
			const thisWeek = await output<Out>(db, owner, 'get_weekly_training_summary', {});
			expect(thisWeek).toMatchObject({ status: 'ok', review: null });
		});
	});
});

describe('scripted turns', () => {
	it('cites this week’s review in ‘What should I focus on next week?’', async () => {
		await withRollback(async (db) => {
			// This week is fully logged, so it can be reviewed before Sunday.
			const { owner, deps } = await seed(db, 'block-end');
			const { review: stored } = await review(owner, deps, THIS_WEEK);
			expect(stored.weekStartsOn).toBe(THIS_WEEK);

			const script = analyticsScripts.find((s) => s.name === 'next-week-focus')!;
			const turn = await runScripted(script, {
				db,
				owner,
				text: 'What should I focus on next week?',
				now
			});
			expect(turn.done.status).toBe('completed');
			const cited = blocksOf(turn.events).filter((b) =>
				b.sources.some((s) => s.type === 'review' && s.id === `w-${THIS_WEEK}`)
			);
			expect(cited).toHaveLength(1);
			expect(cited[0]!.raw).toContain('weekly review');
			expect(await segmentIssues(db, owner, turn.threadId!)).toEqual([]);
		});
	});

	it('attributes the review’s proposal to the weekly review in ‘What did you propose?’', async () => {
		await withRollback(async (db) => {
			const { owner, deps } = await seed(db);
			const { review: stored } = await review(owner, deps);

			const script = programmingReadScripts.find((s) => s.name === 'what-did-you-propose')!;
			expect(script.matches?.('What did you propose?')).toBe(true);
			const turn = await runScripted(script, { db, owner, text: 'What did you propose?', now });
			expect(turn.done.status).toBe('completed');
			const facts = blocksOf(turn.events).filter((b) => b.kind === 'fact');
			const fact = facts.find((b) => b.sources.some((s) => s.id === stored.proposalId))!;
			expect(fact.grounded).toBe(true);
			expect(fact.raw).toContain('Your weekly review proposed');
			expect(fact.raw).toContain('not me');
			expect(fact.sources).toContainEqual(expect.objectContaining(REVIEW_REF));
			expect(facts.some((b) => b.raw.includes('I proposed'))).toBe(false);
		});
	});
});
