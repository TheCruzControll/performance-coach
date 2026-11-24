/**
 * Today's streamed plan (src/routes/(app)/today/plan.server.ts) on real Postgres: the day as one
 * statement with its one Start and its one line (a goal to set, or the next session), the week as
 * seven dots with each other day composed (a past day missed or skipped said as skipped, with no
 * sentence from the coach), a done session as a quiet line with its workout, a done day with how
 * long it took, a rest day naming the next session, the start's day before week 1, 'Nothing yet'
 * once the first block is over and reviewed, and the block as the day while its review is due,
 * its create form the button (none mid-week while sessions remain; a failed prompt read leaves the
 * day). A week to review is the one line under the day. When the database cannot be reached it
 * never rejects: {failed: true}, and the failure recorded as a server error.
 * - It reads the plan and its week together, each on its own connection, so the cases run on the
 *   shared pool (withCommitted), never in one transaction.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { workouts } from '../../../src/lib/server/db';
import { findErrorsByRequestId } from '../../../src/lib/server/services/errors';
import { createGoal } from '../../../src/lib/server/services/profile/index';
import {
	createProgramFromPlan,
	getCurrentProgram,
	getProgramVersion,
	skipSession,
	type CurrentProgram,
	type StoredSession
} from '../../../src/lib/server/services/programs/index';
import {
	programFixture,
	type ProgramFixture
} from '../../../src/lib/server/test-support/program-fixtures';
import type { ReviewPromptView } from '../../../src/lib/ui/analytics/review-prompt';
import {
	blockEndWords,
	completeLead,
	skippedLine,
	STARTS_LEAD
} from '../../../src/routes/(app)/today/day-words';
import { loadTodayPlan, type TodayPlanView } from '../../../src/routes/(app)/today/plan.server';
import type { Executor } from '../../../src/lib/server/db/types';
import { unreachableDb, watchPool, withCommitted, withRollback } from '../helpers';
import { generalGoal, makeOwner } from '../profile/fixtures';
import { logOther, logStrength } from './fixtures/history';

/** A Thursday. */
const TODAY = '2026-11-05';
const origin = (requestId = crypto.randomUUID()) => ({
	requestId,
	method: 'GET',
	path: '/today',
	routeId: '/(app)/today',
	appVersion: '0.1.0+test'
});

async function seeded(db: Executor, fixture: ProgramFixture, monday: string) {
	const owner = await makeOwner(db);
	await createProgramFromPlan(
		owner,
		programFixture(fixture, { monday, today: TODAY }),
		{ source: 'rules' },
		{ db }
	);
	return owner;
}

/**
 * The plan as Today reads it: from the program loadTodayProgram found; with `prompt`, the review
 * prompt it reads in place of review-prompt.server.ts's.
 */
async function viewOf(
	db: Executor,
	owner: string,
	prompt?: (program: CurrentProgram) => ReviewPromptView | null
) {
	const program = await getCurrentProgram(owner, TODAY, { db });
	if (!program) throw new Error('no active program');
	const view = await loadTodayPlan(
		owner,
		{ today: TODAY, program, origin: origin() },
		{ db, ...(prompt && { prompt: async () => prompt(program) }) }
	);
	if (view.failed) throw new Error('the plan failed to load');
	return view;
}

/** A week or block to review, due: what review-prompt.server.ts reads when one is. */
const due = (kind: ReviewPromptView['kind'], fields: Record<string, string>): ReviewPromptView => ({
	kind,
	state: 'due',
	title: kind === 'cycle' ? 'Block complete — review it and plan the next' : 'Your week in review',
	summary: '…',
	href: null,
	create: {
		action: kind === 'cycle' ? '/progress/reviews?/createCycle' : '/progress/reviews?/create',
		fields
	},
	notReady: '…'
});

type View = Extract<TodayPlanView, { failed: false }>;
/** A program in its first block, as the plan needs it when no read can reach the database. */
const ACTIVE = {
	notStarted: false,
	blockComplete: false,
	firstPlannedDay: TODAY
} as CurrentProgram;
const otherOn = (view: View, date: string) => view.others.find((d) => d.date === date)!;

/** A workout's client id, as History links to it. */
async function clientIdOf(db: Executor, workoutId: string) {
	const [row] = await db
		.select({ clientId: workouts.clientId })
		.from(workouts)
		.where(eq(workouts.id, workoutId));
	return row!.clientId;
}

describe('Today’s plan', () => {
	it('shows today’s session with one Start, the week as dots, and each other day', async () => {
		await withCommitted(async (db) => {
			const owner = await seeded(db, 'today', '2026-11-02');
			const view = await viewOf(db, owner);
			expect(view.today).toBe(TODAY);
			// Monday to Sunday: Wednesday's easy run was missed, today has two sessions to do.
			expect(view.dots!.map((d) => [d.letter, d.mark])).toEqual([
				['M', 'rest'],
				['T', 'rest'],
				['W', 'planned'],
				['T', 'today'],
				['F', 'rest'],
				['S', 'rest'],
				['S', 'rest']
			]);
			expect(view.dots![3]!.name).toBe('Thursday 5 November, today, 2 sessions');
			const strength = view.day.lead!.lineage;
			expect(view.day).toMatchObject({
				state: 'session',
				date: TODAY,
				title: 'Full body',
				// Nothing is done yet in week 1: this is the first session, of a baseline week.
				when: 'Your first session · strength · about 60 min',
				coach: 'Start light today. I’ll set your weights from how these sets feel.',
				lead: {
					link: { id: 'start-workout', href: `/workout?start=${strength}` }
				},
				rows: [],
				log: null
			});
			// No goal is set: the one line asks for one, ahead of the class later today.
			expect(view.day.lines).toEqual([
				{
					kind: 'goal',
					label: 'Goal',
					title: 'None set yet',
					end: 'Add one',
					tick: false,
					quiet: false,
					href: '/profile/goals',
					chevron: true
				}
			]);
			// Every other day of the week, composed for a tap on its dot.
			expect(view.others.map((d) => d.date)).toEqual([
				'2026-11-02',
				'2026-11-03',
				'2026-11-04',
				'2026-11-06',
				'2026-11-07',
				'2026-11-08'
			]);
			// Wednesday has passed with its run missed: said as skipped, with no sentence to train by.
			const wednesday = otherOn(view, '2026-11-04');
			expect(wednesday).toMatchObject({
				state: 'other-day',
				title: 'Easy run',
				when: skippedLine(['Easy run']),
				coach: null,
				lead: null
			});
			expect(wednesday.rows.map((r) => [r.title, r.testId, r.secondary])).toEqual([
				['Open the session', 'open-session', false],
				['Back to today', 'today-back', true]
			]);
			expect(wednesday.rows[0]!.href).toMatch(/^\/train\/session\//);
			expect(otherOn(view, '2026-11-06')).toMatchObject({
				title: 'Rest day',
				when: 'Nothing planned.',
				rows: [{ title: 'Back to today', href: null, testId: 'today-back' }]
			});
			// The coming days' sessions, for their kits: this week's and the next ones after today.
			expect(view.coming.filter((s) => s.date >= TODAY).map((s) => s.date)).toEqual([
				TODAY,
				TODAY,
				'2026-11-09',
				'2026-11-10',
				'2026-11-11'
			]);

			// With a goal set, the one line is the next session: the class later today.
			await createGoal(owner, generalGoal(), { db });
			const later = (await viewOf(db, owner)).day.lines;
			expect(later).toEqual([
				{
					kind: 'later',
					label: 'Later',
					title: 'Muay Thai class',
					end: '90 min',
					tick: false,
					quiet: false,
					href: expect.stringMatching(/^\/train\/session\//),
					chevron: false
				}
			]);

			// Skipping today's strength session leads with the class; the dot says one is skipped.
			await skipSession(owner, { sessionLineage: strength }, { version: 1, today: TODAY }, { db });
			const after = await viewOf(db, owner);
			expect(after.day).toMatchObject({
				state: 'session',
				title: 'Muay Thai class',
				when: 'Your first session · class · 90 min'
			});
			expect(after.dots![3]).toMatchObject({ mark: 'today' });
			expect(after.dots![3]!.name).toMatch(/1 skipped/);
		});
	});

	it('shows a done session as a quiet line to its workout, then the done day with how long it took', async () => {
		await withCommitted(async (db) => {
			const owner = await makeOwner(db);
			const plan = programFixture('today', { monday: '2026-11-02', today: TODAY });
			const { programId } = await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
			const v1 = await getProgramVersion(owner, programId, 1, { db });
			const sessions = v1.blocks[0]!.weeks[0]!.sessions as StoredSession[];
			const pin = (title: string) => {
				const s = sessions.find((x) => x.date === TODAY && x.title === title)!;
				return { sessionId: s.id, lineageId: s.lineage, programId };
			};
			const { workoutId } = await logStrength(
				db,
				owner,
				{
					startedAt: new Date(`${TODAY}T08:00:00Z`),
					planned: pin('Full body'),
					durationSeconds: 3480
				},
				[]
			);
			const fullBody = await clientIdOf(db, workoutId);

			const view = await viewOf(db, owner);
			expect(view.day).toMatchObject({
				state: 'session',
				title: 'Muay Thai class',
				lead: { link: { id: 'start-workout' } }
			});
			// Done today already: no longer the first session.
			expect(view.day.when).toBe('This evening · class · 90 min');
			expect(view.day.lines).toEqual([
				{
					kind: 'done',
					label: 'Morning',
					title: 'Full body',
					end: null,
					tick: true,
					quiet: true,
					href: `/progress/workouts/${fullBody}`,
					chevron: false
				}
			]);
			expect(view.dots![3]!.mark).toBe('today');

			const classId = await logOther(db, owner, {
				startedAt: new Date(`${TODAY}T18:00:00Z`),
				planned: pin('Muay Thai class'),
				durationSeconds: 1800
			});
			const done = await viewOf(db, owner);
			// Each completed workout's length reaches the day's when line.
			expect(done.day).toMatchObject({
				state: 'done',
				title: 'All done',
				when: 'Two sessions · 1 h 28 min',
				coach: null,
				lead: null
			});
			expect(done.day.lines.map((l) => [l.kind, l.label, l.title, l.href, l.chevron])).toEqual([
				['done', 'Morning', 'Full body', `/progress/workouts/${fullBody}`, true],
				[
					'done',
					'Evening',
					'Muay Thai class',
					`/progress/workouts/${await clientIdOf(db, classId)}`,
					true
				],
				['later', 'Monday', 'Full body', expect.stringMatching(/^\/train\/session\//), false]
			]);
			expect(done.dots![3]!.mark).toBe('today-done');
		});
	});

	it('says a past day whose sessions were skipped as skipped, with no coach sentence', async () => {
		await withCommitted(async (db) => {
			const owner = await seeded(db, 'today', '2026-11-02');
			const before = await viewOf(db, owner);
			const run = otherOn(before, '2026-11-04').rows[0]!.href!.split('/').at(-1)!;
			// Skipped on Tuesday, before its day came.
			await skipSession(
				owner,
				{ sessionLineage: run },
				{ version: 1, today: '2026-11-03' },
				{ db }
			);
			const view = await viewOf(db, owner);
			expect(view.dots![2]!.mark).toBe('skipped');
			expect(otherOn(view, '2026-11-04')).toMatchObject({
				state: 'other-day',
				title: 'Easy run',
				when: 'Easy run. The rest of the week stays as it is.',
				coach: null,
				lead: null
			});
		});
	});

	it('reads the plan and the week it shows together, each on its own connection', async () => {
		await withCommitted(async (db) => {
			const owner = await seeded(db, 'today', '2026-11-02');
			const program = (await getCurrentProgram(owner, TODAY, { db }))!;
			const pool = watchPool();
			const view = await loadTodayPlan(
				owner,
				{ today: TODAY, program, origin: origin() },
				{ db }
			).finally(pool.stop);
			expect(view).toMatchObject({ failed: false, day: { state: 'session', date: TODAY } });
			expect(pool.peak()).toBeGreaterThan(1);
		});
	});

	it('on a rest day, names the next session', async () => {
		await withCommitted(async (db) => {
			const owner = await seeded(db, 'today-rest', '2026-11-02');
			const view = await viewOf(db, owner);
			expect(view.day).toMatchObject({
				state: 'rest',
				title: 'Rest day',
				when: 'Nothing planned. Recovery is part of the plan.',
				lead: null,
				log: 'anyway'
			});
			expect(view.day.lines).toMatchObject([
				{ kind: 'later', label: 'Tomorrow', title: 'Intervals', end: '45 min' }
			]);
			expect(view.dots![3]!.mark).toBe('rest');
		});
	});

	it('before week 1, says the day it starts, with week 1’s first session', async () => {
		await withCommitted(async (db) => {
			const owner = await seeded(db, 'hybrid', '2026-11-09');
			const view = await viewOf(db, owner);
			expect(view.dots).toBeNull();
			expect(view.others).toEqual([]);
			expect(view.day).toMatchObject({
				state: 'starts',
				title: 'Monday',
				when: STARTS_LEAD,
				lead: null,
				log: 'anyway'
			});
			expect(view.day.lines).toMatchObject([
				{ kind: 'later', label: 'Monday', title: 'Full body', end: '60 min' }
			]);
			// Week 1's sessions, for their kits.
			expect(view.coming[0]).toMatchObject({ date: '2026-11-09', status: 'planned' });
		});
	});

	it('once the first block is over and reviewed, nothing is planned yet, with the way back', async () => {
		await withCommitted(async (db) => {
			const owner = await seeded(db, 'one-week', '2026-10-26');
			// Its review written: the prompt reads it as reviewed, which Today does not show.
			const view = await viewOf(db, owner, () => null);
			expect(view).toEqual({
				failed: false,
				today: TODAY,
				dots: null,
				others: [],
				coming: [],
				day: {
					state: 'complete',
					date: TODAY,
					title: 'Nothing yet',
					when: completeLead(1, '2026-10-26', '2026-11-01'),
					coach: null,
					lead: null,
					review: null,
					lines: [],
					rows: [
						{
							title: 'Look back at every week',
							href: '/train',
							secondary: false,
							testId: 'today-train-link'
						},
						{
							title: 'Log something',
							href: '/workout',
							secondary: false,
							testId: 'log-something-else'
						}
					],
					log: null
				}
			});
			expect(view.day.when).toBe(
				'One week trained · You trained 26 October to 1 November. I plan the next block from how this one went.'
			);
		});
	});

	it('while the block’s review is due, the block is the day, with its create form as the button', async () => {
		await withCommitted(async (db) => {
			const owner = await seeded(db, 'one-week', '2026-10-26');
			const program = (await getCurrentProgram(owner, TODAY, { db }))!;
			// The one planned week, then the outline's next block.
			const [block, next] = program.blocks;
			expect(next).toBeDefined();
			const view = await viewOf(db, owner);
			// The block is over and has no review: review-prompt.server.ts reads it as due.
			expect(view.dots).toBeNull();
			expect(view.others).toEqual([]);
			expect(view.day).toMatchObject({
				state: 'block-end',
				// 'Done', 'One week of …', and the coach's sentence naming the outline's next block.
				...blockEndWords({ weeks: 1, name: block!.name, next: next!.name }),
				lead: null,
				lines: [],
				rows: [],
				log: null,
				review: {
					kind: 'cycle',
					state: 'due',
					create: {
						action: '/progress/reviews?/createCycle',
						fields: { programId: program.id, blockLineage: block!.lineage }
					}
				}
			});
		});
	});

	it('a block to review mid-week leads, with today’s session as its line', async () => {
		await withCommitted(async (db) => {
			const owner = await seeded(db, 'today', '2026-11-02');
			const view = await viewOf(db, owner, (program) =>
				due('cycle', { programId: program.id, blockLineage: program.blocks[0]!.lineage })
			);
			expect(view.dots).toHaveLength(7);
			expect(view.others).toHaveLength(6);
			expect(view.day).toMatchObject({ state: 'block-end', title: 'Done', lead: null });
			expect(view.day.when).toMatch(/ weeks? of /);
			expect(view.day.review?.create?.action).toBe('/progress/reviews?/createCycle');
			expect(view.day.lines).toMatchObject([
				{ kind: 'later', label: 'Today', title: 'Full body', chevron: false }
			]);
		});
	});

	it('a week to review is the one line under the day, ahead of a goal or the next session', async () => {
		await withCommitted(async (db) => {
			const owner = await seeded(db, 'today', '2026-11-02');
			const review = {
				kind: 'review',
				label: 'Last week',
				title: 'Review ready',
				end: null,
				tick: false,
				quiet: false,
				href: '/progress/reviews',
				chevron: true
			};
			const lastWeek = await viewOf(db, owner, () => due('weekly', { weekStartsOn: '2026-10-26' }));
			expect(lastWeek.day).toMatchObject({ state: 'session', title: 'Full body', review: null });
			expect(lastWeek.day.lines).toEqual([review]);
			// Written early, once every session of this week is resolved: 'This week'.
			const thisWeek = await viewOf(db, owner, () => due('weekly', { weekStartsOn: '2026-11-02' }));
			expect(thisWeek.day.lines).toEqual([{ ...review, label: 'This week' }]);
			// Each other day keeps its own rows: the line is today's.
			expect(thisWeek.others.every((d) => d.lines.length === 0)).toBe(true);
		});
	});

	it('offers no review mid-week while sessions remain, in a program that started this week', async () => {
		await withCommitted(async (db) => {
			const owner = await seeded(db, 'today', '2026-11-02');
			const view = await viewOf(db, owner);
			expect(view.day).toMatchObject({ state: 'session', review: null });
			expect(view.day.lines.map((l) => l.kind)).not.toContain('review');
		});
	});

	it('a failed review prompt read is recorded, and the plan shows without it', async () => {
		await withCommitted(async (db) => {
			const owner = await seeded(db, 'today', '2026-11-02');
			const program = (await getCurrentProgram(owner, TODAY, { db }))!;
			// The error row is written in a transaction rolled back after, not left committed.
			await withRollback(async (tx) => {
				const request = origin();
				const view = await loadTodayPlan(
					owner,
					{ today: TODAY, program, origin: request },
					{
						db,
						errorsDb: tx,
						prompt: async () => {
							throw new Error('lock timeout');
						}
					}
				);
				expect(view).toMatchObject({ failed: false, day: { state: 'session', review: null } });
				const recorded = await findErrorsByRequestId(request.requestId, { db: tx });
				expect(recorded).toHaveLength(1);
				expect(recorded[0]).toMatchObject({
					kind: 'streamed',
					context: expect.objectContaining({ load: 'todayReviewPrompt' })
				});
			});
		});
	});

	it('fails soft when the database cannot be reached, and records the failure', async () => {
		const broken = unreachableDb();
		try {
			await withRollback(async (tx) => {
				const request = origin();
				const view = await loadTodayPlan(
					crypto.randomUUID(),
					{ today: TODAY, program: ACTIVE, origin: request },
					{ db: broken.db, errorsDb: tx }
				);
				expect(view).toEqual({ failed: true });
				const recorded = await findErrorsByRequestId(request.requestId, { db: tx });
				expect(recorded).toHaveLength(1);
				expect(recorded[0]).toMatchObject({
					kind: 'streamed',
					status: 500,
					path: '/today',
					context: expect.objectContaining({ load: 'todayPlan' })
				});
			});
		} finally {
			await broken.close();
		}
	});
});
