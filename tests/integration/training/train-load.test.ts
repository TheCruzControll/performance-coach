/**
 * Train's load (src/routes/(app)/train/week.server.ts) on real Postgres: the current program and
 * one week of it, server-rendered from the owner's own today. ?week=n names the program's week n,
 * a malformed value is the current week, a week past the plan is 'not planned yet', and once the
 * planned weeks are over the current view is 'first block complete'. With no program it says
 * whether the profile is ready for a build. When the database cannot be reached the load fails
 * soft: the designed error payload, and the failure recorded as a server error.
 */
import { describe, expect, it } from 'vitest';
import type { IsoDate } from '../../../src/lib/domain/calendar';
import type { Executor } from '../../../src/lib/server/db';
import { findErrorsByRequestId } from '../../../src/lib/server/services/errors';
import {
	completeOnboarding,
	createGoal,
	saveSchedule
} from '../../../src/lib/server/services/profile/index';
import { createProgramFromPlan } from '../../../src/lib/server/services/programs/index';
import {
	programFixture,
	type ProgramFixture
} from '../../../src/lib/server/test-support/program-fixtures';
import { loadTrainWeek, type TrainWeekData } from '../../../src/routes/(app)/train/week.server';
import { unreachableDb, withRollback } from '../helpers';
import { eventGoal, generalGoal, makeOwner } from '../profile/fixtures';

/**
 * Week 1's Monday. The owner's profile is on UTC (M2's default), so `at` gives today exactly.
 * One owner per transaction: the app has exactly one.
 */
const MONDAY = '2026-11-09';
const at = (day: IsoDate) => new Date(`${day}T12:00:00Z`);

const origin = (requestId = crypto.randomUUID()) => ({
	requestId,
	method: 'GET',
	path: '/train',
	routeId: '/(app)/train',
	appVersion: '0.1.0+test'
});

async function withProgram(db: Executor, fixture: ProgramFixture = 'hybrid') {
	const owner = await makeOwner(db);
	const plan = programFixture(fixture, { monday: MONDAY, today: MONDAY });
	await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
	return owner;
}

function load(db: Executor, owner: string, today: IsoDate, week: string | null = null) {
	return loadTrainWeek(owner, { now: at(today), week, origin: origin() }, { db });
}

/** The program view (fails the test for any other state). */
function program(data: TrainWeekData) {
	if (data.state !== 'program') throw new Error(`expected a program, got ${data.state}`);
	return data;
}

describe('Train’s load', () => {
	it('shows the week that holds the owner’s today, with its days and sessions', async () => {
		await withRollback(async (db) => {
			const owner = await withProgram(db);
			const data = program(await load(db, owner, '2026-11-18'));
			expect(data.today).toBe('2026-11-18');
			expect(data.shown).toBe(2);
			expect(data.totalWeeks).toBe(5);
			expect(data.asked).toBe(false);
			expect(data.card).toBeNull();
			expect(data.program).toMatchObject({ currentWeek: 2, plannedWeeks: 5, baseline: false });
			expect(data.week).toMatchObject({ planned: true, number: 2, startsOn: '2026-11-16' });
			const days = data.week.planned ? data.week.days : [];
			expect(days.map((d) => d.sessions.map((s) => s.title))).toEqual([
				['Full body'],
				['Muay Thai class'],
				['Intervals'],
				['Easy run', 'Muay Thai class'],
				[],
				[],
				[]
			]);
			// In words, composed here so the screen ships no vocabulary.
			expect(data.strip[3]).toMatchObject({
				name: 'Thursday 19 November, 2 sessions',
				short: 'Thu'
			});
			expect(data.days[0]).toMatchObject({
				heading: 'Monday 16 November',
				rest: null,
				cards: [{ title: 'Full body', line: 'Strength · 60 min · Moderate · Morning' }]
			});
			expect(data.days[4]!.rest).toBe(
				'Recovery is part of the plan. Nothing else is planned this week.'
			);
		});
	});

	it('shows the week ?week names, and the current week for anything malformed', async () => {
		await withRollback(async (db) => {
			const owner = await withProgram(db);
			const asked = program(await load(db, owner, '2026-11-11', '4'));
			expect(asked).toMatchObject({ shown: 4, asked: true });
			expect(asked.week).toMatchObject({ planned: true, number: 4, startsOn: '2026-11-30' });
			for (const malformed of ['abc', '0', '-1', '2.5', '1e1', '1000', ' 2', '']) {
				const data = program(await load(db, owner, '2026-11-11', malformed));
				expect({ malformed, shown: data.shown, asked: data.asked }).toEqual({
					malformed,
					shown: 1,
					asked: false
				});
				expect(data.week).toMatchObject({ planned: true, number: 1, kind: 'baseline' });
			}
		});
	});

	it('says a week past the plan is not planned yet, with the outline phase when there is one', async () => {
		await withRollback(async (db) => {
			const beyond = program(await load(db, await withProgram(db), '2026-11-11', '99'));
			expect(beyond).toMatchObject({ shown: 99, asked: true, totalWeeks: 5 });
			expect(beyond.week).toMatchObject({ planned: false, phase: null });
			expect(beyond.card).toMatchObject({
				id: 'train-not-planned',
				description: 'Week 99 is past the end of your plan.',
				next: { to: 'this-week' }
			});
		});
		await withRollback(async (db) => {
			const outline = program(await load(db, await withProgram(db, 'one-week'), MONDAY, '3'));
			expect(outline).toMatchObject({ shown: 3, totalWeeks: 4 });
			expect(outline.week).toMatchObject({ planned: false, phase: 'accumulation' });
			expect(outline.card?.description).toBe(
				'Week 3 is in the Accumulation phase. Its sessions are planned closer to the time, from how your training goes.'
			);
		});
	});

	it('before the start shows week 1 and the day it starts; after the planned weeks, the block is complete', async () => {
		await withRollback(async (db) => {
			const early = program(await load(db, await withProgram(db), '2026-11-05'));
			expect(early.program).toMatchObject({ notStarted: true, currentWeek: 1 });
			expect(early).toMatchObject({ shown: 1, asked: false });
			expect(early.week).toMatchObject({ planned: true, number: 1, programStartsOn: MONDAY });
		});
		await withRollback(async (db) => {
			const owner = await withProgram(db, 'one-week');
			const done = program(await load(db, owner, '2026-11-19'));
			expect(done.program).toMatchObject({ blockComplete: true, currentWeek: null });
			expect(done).toMatchObject({ shown: 2, asked: false });
			expect(done.week).toMatchObject({ planned: false, phase: 'accumulation' });
			expect(done.card).toMatchObject({
				id: 'train-block-complete',
				description:
					'You trained through every planned week, Mon 9 Nov – Sun 15 Nov. Your next block is planned from how this one went, starting with Accumulation.',
				next: { title: 'Look back at week 1', to: { week: 1 } }
			});
			// Asked for by number, a past week is just that week, and an outline week is not
			// planned yet: only the current view says the block is complete.
			const back = program(await load(db, owner, '2026-11-19', '1'));
			expect(back).toMatchObject({ shown: 1, asked: true, card: null });
			const ahead = program(await load(db, owner, '2026-11-19', '3'));
			expect(ahead).toMatchObject({ shown: 3, asked: true, card: { id: 'train-not-planned' } });
		});
	});

	it('lays out the whole plan: each block’s weeks, this week, the outline and the event it leads to', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			// The fight is on the Saturday of week 4, the outline's last week.
			const fight = await createGoal(owner, eventGoal({ eventDate: '2026-12-05' }), { db });
			const other = await createGoal(owner, eventGoal({ title: 'Not in this plan' }), { db });
			const plan = programFixture('one-week', {
				monday: MONDAY,
				today: MONDAY,
				goalRefs: [fight.id]
			});
			await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });

			const data = program(await load(db, owner, '2026-11-11', '3'));
			expect(other.eventDate).toBe('2027-03-14');
			expect(
				data.plan.map(({ name, span, outline, current }) => ({ name, span, outline, current }))
			).toEqual([
				{
					name: 'Baseline week',
					span: 'Mon 9 Nov – Sun 15 Nov · 1 week',
					outline: false,
					current: true
				},
				{
					name: 'Accumulation',
					span: 'Mon 16 Nov – Sun 6 Dec · 3 weeks',
					outline: true,
					current: false
				}
			]);
			// The week shown (?week=3) does not move this week: today's week is marked.
			const weeks = data.plan.flatMap((block) => block.weeks);
			expect(weeks.map((w) => [w.number, w.planned, w.current])).toEqual([
				[1, true, true],
				[2, false, false],
				[3, false, false],
				[4, false, false]
			]);
			expect(weeks.flatMap((w) => w.events.map((e) => [w.number, e.title, e.date]))).toEqual([
				[4, 'First Muay Thai fight', 'Sat 5 Dec']
			]);
		});
	});

	it('with no program, says whether the training profile is ready for a build', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const data = await load(db, owner, MONDAY);
			expect(data).toMatchObject({ state: 'none', today: MONDAY, profileComplete: false });
			if (data.state !== 'none') throw new Error('expected no program');
			expect(data.card).toMatchObject({ id: 'train-empty', title: 'No program yet' });
			expect(data.card.next).toMatchObject({ title: 'Set up my profile', to: 'profile' });
		});
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await createGoal(owner, generalGoal(), { db });
			const schedule = { daysPerWeek: 4, availableDays: [], preferredTimes: [], commitments: [] };
			await saveSchedule(owner, schedule, { db });
			await completeOnboarding(owner, { db });
			const data = await load(db, owner, MONDAY);
			expect(data).toMatchObject({ state: 'none', profileComplete: true });
			if (data.state !== 'none') throw new Error('expected no program');
			expect(data.card.description).toContain('Your training profile is ready');
			expect(data.card.next).toMatchObject({ title: 'Build my program', to: 'today' });
		});
	});

	it('fails soft when the database cannot be reached, and records the failure', async () => {
		const broken = unreachableDb();
		try {
			await withRollback(async (tx) => {
				const request = origin();
				const data = await loadTrainWeek(
					crypto.randomUUID(),
					{ now: at(MONDAY), week: '2', origin: request },
					{ db: broken.db, errorsDb: tx }
				);
				expect(data).toMatchObject({ state: 'error', card: { id: 'train-error' } });
				expect(data.card?.next).toMatchObject({ title: 'Retry', to: 'retry' });
				const recorded = await findErrorsByRequestId(request.requestId, { db: tx });
				expect(recorded).toHaveLength(1);
				expect(recorded[0]).toMatchObject({
					kind: 'load',
					status: 500,
					method: 'GET',
					path: '/train',
					routeId: '/(app)/train',
					appVersion: '0.1.0+test',
					context: expect.objectContaining({ load: 'train' })
				});
				expect(recorded[0]!.message.length).toBeGreaterThan(0);
			});
		} finally {
			await broken.close();
		}
	});
});
