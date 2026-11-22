/**
 * The review prompt Today and Progress lead with (review-prompt.server.ts), on faked services:
 * a block to review comes first, then its new review (kept once the next block starts), then a week
 * to review, then this week's or last week's review; only with a program and only for a week a
 * planned block covers; one read at a time.
 */
import { describe, expect, it } from 'vitest';
import type { CurrentProgram } from '#lib/server/services/programs/index.ts';
import type {
	StoredCycleReview,
	StoredWeeklyReview,
	UnreviewedBlock
} from '#lib/server/services/reviews/index.ts';
import { loadReviewPrompt, SEE_REVIEW_DAYS, type ReviewPromptDeps } from './review-prompt.server';

/** A Thursday. */
const TODAY = '2026-11-12';
const THIS_WEEK = '2026-11-09';
const LAST_WEEK = '2026-11-02';
const PROGRAM_ID = '11111111-1111-4111-8111-111111111111';
const BASE = '22222222-2222-4222-8222-222222222222';
const BUILD = '33333333-3333-4333-8333-333333333333';
const db = {} as NonNullable<ReviewPromptDeps['db']>;

interface World {
	program?: Partial<CurrentProgram> | null;
	block?: UnreviewedBlock | null;
	cycleReviews?: Record<string, string>;
	week?: string | null;
	weekReviews?: Record<string, string>;
}

/** The services, faked over `world`, logging each read in the order it starts and ends. */
function deps(world: World) {
	const log: string[] = [];
	let busy = false;
	const read =
		<A extends unknown[], R>(name: string, answer: (...args: A) => R) =>
		async (...args: A): Promise<R> => {
			expect(busy, `${name} started while another read was running`).toBe(false);
			busy = true;
			log.push(name);
			await new Promise((resolve) => setTimeout(resolve, 1));
			busy = false;
			return answer(...args);
		};
	const program =
		world.program === null
			? null
			: ({
					id: PROGRAM_ID,
					firstPlannedDay: '2026-10-12',
					lastPlannedDay: '2026-12-06',
					blocks: [
						{ lineage: BASE, startsOn: '2026-10-12', endsOn: '2026-11-08', plannedWeeks: 4 },
						{ lineage: BUILD, startsOn: '2026-11-09', endsOn: '2026-12-06', plannedWeeks: 4 }
					],
					...world.program
				} as CurrentProgram);
	const given: ReviewPromptDeps = {
		db,
		program: read('program', () => program),
		block: read('block', () => world.block ?? null),
		cycleReview: read('cycleReview', (_owner: string, _program: string, lineage: string) => {
			const summary = world.cycleReviews?.[lineage];
			return summary ? ({ id: `c-id-${lineage}`, summary } as StoredCycleReview) : null;
		}),
		week: read('week', () =>
			world.week ? { weekStartsOn: world.week, reason: 'ended' as const } : null
		),
		weekReview: read('weekReview', (_owner: string, monday: string) => {
			const summary = world.weekReviews?.[monday];
			return summary ? ({ summary } as StoredWeeklyReview) : null;
		})
	};
	return { given, log };
}

const prompt = (world: World, today = TODAY) => {
	const { given, log } = deps(world);
	return loadReviewPrompt('owner-1', today, given).then((view) => ({ view, log }));
};

describe('the review prompt', () => {
	it('offers nothing without a program, reading nothing else', async () => {
		const { view, log } = await prompt({ program: null, week: LAST_WEEK });
		expect(view).toBeNull();
		expect(log).toEqual(['program']);
	});

	it('leads with a block to review: its create form posts the block', async () => {
		const block = {
			...{ programId: PROGRAM_ID, blockLineage: BUILD, name: 'Build' },
			...{ startsOn: '2026-10-12', endsOn: '2026-11-08', reviewable: true }
		};
		const { view, log } = await prompt({ block, week: LAST_WEEK });
		expect(view).toEqual({
			kind: 'cycle',
			state: 'due',
			title: 'Block complete — review it and plan the next',
			summary: 'Build · Mon 12 Oct – Sun 8 Nov: what it built, and how your next block starts.',
			href: null,
			create: {
				action: '/progress/reviews?/createCycle',
				fields: { programId: PROGRAM_ID, blockLineage: BUILD }
			},
			notReady: 'Your cycle review is ready once the block ends, or once its last week is done'
		});
		// The block's review covers its last week: no weekly read.
		expect(log).toEqual(['program', 'block']);
	});

	it('offers a week to review, inside the program, with the create form for its Monday', async () => {
		// Week 3 of Base: last week (week 2) ended unreviewed.
		const running = {
			...{ programId: PROGRAM_ID, blockLineage: BASE, name: 'Base' },
			...{ startsOn: '2026-10-12', endsOn: '2026-11-08', reviewable: false }
		};
		const { view, log } = await prompt({ block: running, week: '2026-10-19' }, '2026-10-29');
		expect(view).toEqual({
			kind: 'weekly',
			state: 'due',
			title: 'Your week in review is ready',
			summary: 'Mon 19 Oct – Sun 25 Oct: how it went, and what changes next week.',
			href: null,
			create: { action: '/progress/reviews?/create', fields: { weekStartsOn: '2026-10-19' } },
			notReady: 'Your review is ready after Sunday, or once every session is done or skipped'
		});
		expect(log).toEqual(['program', 'block', 'cycleReview', 'week']);
	});

	it('keeps the ended block’s review once the next block starts, not its last week', async () => {
		// Base's review planned Build from this Monday; Base's last week has no weekly review.
		const { view, log } = await prompt({
			cycleReviews: { [BASE]: 'Base built your squat.' },
			week: LAST_WEEK
		});
		expect(view).toMatchObject({
			kind: 'cycle',
			state: 'reviewed',
			href: `/progress/reviews/c-c-id-${BASE}`
		});
		// Build first (newest), then Base.
		expect(log).toEqual(['program', 'block', 'cycleReview', 'cycleReview']);
	});

	it('offers nothing for a bridge week between blocks', async () => {
		// Base ended 25 Oct; the late start left two unplanned bridge weeks; Build starts this Monday.
		const program = {
			blocks: [
				{ lineage: BASE, startsOn: '2026-09-28', endsOn: '2026-10-25', plannedWeeks: 4 },
				{
					...{ lineage: 'bridge', phase: 'transition', plannedWeeks: 2 },
					...{ startsOn: '2026-10-26', endsOn: '2026-11-08' }
				},
				{ lineage: BUILD, startsOn: THIS_WEEK, endsOn: '2026-12-06', plannedWeeks: 4 }
			],
			firstPlannedDay: '2026-09-28'
		} as Partial<CurrentProgram>;
		const { view, log } = await prompt({ program, week: LAST_WEEK });
		expect(view).toBeNull();
		// Only this week's review is looked for: last week, the bridge's, is not covered.
		expect(log).toEqual(['program', 'block', 'cycleReview', 'week', 'weekReview']);
	});

	it('reads "See your review" once the block’s review exists, until SEE_REVIEW_DAYS after it ends', async () => {
		const world: World = {
			program: {
				lastPlannedDay: '2026-11-08',
				blocks: [{ lineage: BASE, startsOn: '2026-10-12', endsOn: '2026-11-08', plannedWeeks: 4 }]
			} as Partial<CurrentProgram>,
			cycleReviews: { [BASE]: 'Base built your squat.' },
			week: THIS_WEEK
		};
		const { view } = await prompt(world);
		expect(view).toMatchObject({
			kind: 'cycle',
			state: 'reviewed',
			title: 'Your block in review',
			summary: 'Base built your squat.',
			href: `/progress/reviews/c-c-id-${BASE}`,
			create: null
		});

		// The day after the window: the week's own prompt instead (here: none, it is past the plan).
		const after = await prompt(world, '2026-11-16');
		expect(SEE_REVIEW_DAYS).toBe(7);
		expect(after.view).toBeNull();
		expect(after.log).not.toContain('cycleReview');
	});

	it('offers nothing for the week before week 1, nor for a week after everything planned', async () => {
		const first = { lineage: BUILD, startsOn: THIS_WEEK, endsOn: '2026-12-06', plannedWeeks: 4 };
		const early = await prompt(
			{
				program: { firstPlannedDay: THIS_WEEK, blocks: [first] } as Partial<CurrentProgram>,
				week: LAST_WEEK
			},
			TODAY
		);
		expect(early.view).toBeNull();
		// Last week is not covered either, so only this week's review is looked for.
		expect(early.log).toEqual(['program', 'block', 'cycleReview', 'week', 'weekReview']);

		const late = await prompt({ program: { lastPlannedDay: '2026-11-01' }, week: LAST_WEEK });
		expect(late.view).toBeNull();
	});

	it('reads "See your review" for this week’s early review first, else last week’s', async () => {
		const both = await prompt({
			weekReviews: { [THIS_WEEK]: 'Every session done.', [LAST_WEEK]: 'A hard week.' }
		});
		expect(both.view).toEqual({
			kind: 'weekly',
			state: 'reviewed',
			title: 'Your week in review',
			summary: 'Every session done.',
			href: `/progress/reviews/w-${THIS_WEEK}`,
			create: null,
			notReady: 'Your review is ready after Sunday, or once every session is done or skipped'
		});

		const last = await prompt({ weekReviews: { [LAST_WEEK]: 'A hard week.' } });
		expect(last.view).toMatchObject({ href: `/progress/reviews/w-${LAST_WEEK}` });
		expect(last.log).toEqual([
			'program',
			'block',
			'cycleReview',
			'cycleReview',
			'week',
			'weekReview',
			'weekReview'
		]);
	});

	it('offers nothing mid-week while this week runs and last week is reviewed', async () => {
		const { view } = await prompt({ week: null });
		expect(view).toBeNull();
	});
});
