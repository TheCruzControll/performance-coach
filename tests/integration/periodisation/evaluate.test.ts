/**
 * Train's week findings (services/periodisation/evaluate.ts) on real Postgres, for the
 * periodisation-week fixture on a pinned Wednesday: the owner's move of Lower A to the day
 * before Tuesday's hard Muay Thai is one avoid finding, on both sessions, kept because the owner
 * moved it; the week after is clear; a skipped session is left out; a clash whose day has
 * passed is not shown; the owner's own exercises supply their traits; another owner's version is
 * not found. Train's load carries the notes and the week line, and an evaluation that fails is
 * recorded while the week still renders.
 */
import { describe, expect, it } from 'vitest';
import { addDays, type IsoDate } from '../../../src/lib/domain/calendar';
import { INTERFERENCE_RULES } from '../../../src/lib/domain/programming/interference';
import type { Executor } from '../../../src/lib/server/db';
import { findErrorsByRequestId } from '../../../src/lib/server/services/errors';
import { createCustomExercise } from '../../../src/lib/server/services/exercises/index';
import {
	getWeekEvaluation,
	type WeekFindingsView
} from '../../../src/lib/server/services/periodisation/evaluate';
import {
	createProgramFromPlan,
	getCurrentProgram,
	getProgramVersion,
	skipSession
} from '../../../src/lib/server/services/programs/index';
import { finishWorkout, startWorkout } from '../../../src/lib/server/services/training/log';
import { TrainingNotFoundError } from '../../../src/lib/server/services/training/shared';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import {
	FIXTURE_WEEKS,
	type PeriodisationWeekResult
} from '../../../src/lib/server/test-support/analytics-fixtures/periodisation-week';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { loadTrainWeek, type TrainWeekData } from '../../../src/routes/(app)/train/week.server';
import { unreachableDb, withRollback } from '../helpers';
import { makeOwner, makeSecondOwner } from '../profile/fixtures';

/** Wednesday 11 November 2026, noon, on UTC: this week starts Monday 9 November. */
const NOW = new Date('2026-11-11T12:00:00Z');
const TODAY = '2026-11-11';
const WHY = INTERFERENCE_RULES.heavy_lower_before_hard.why;

async function seed(db: Executor) {
	const owner = await makeOwner(db);
	const seeded = (await seedAnalyticsFixture(
		owner,
		'periodisation-week',
		{ timeZone: 'UTC', now: NOW },
		{ db }
	)) as unknown as PeriodisationWeekResult;
	const program = (await getCurrentProgram(owner, TODAY, { db }))!;
	return { owner, seeded, version: program.version };
}

function evaluate(
	db: Executor,
	owner: string,
	version: number,
	weekStartsOn: IsoDate
): Promise<WeekFindingsView> {
	return getWeekEvaluation(owner, { version, weekStartsOn, today: TODAY }, { db });
}

const origin = (requestId = crypto.randomUUID()) => ({
	requestId,
	method: 'GET',
	path: '/train',
	routeId: '/(app)/train',
	appVersion: '0.1.0+test'
});

function program(data: TrainWeekData) {
	if (data.state !== 'program') throw new Error(`expected a program, got ${data.state}`);
	return data;
}

describe('getWeekEvaluation', () => {
	it('the owner’s move is one avoid finding on both sessions, kept because the owner moved it', async () => {
		await withRollback(async (db) => {
			const { owner, seeded, version } = await seed(db);
			const { moved, hardMuayThai } = seeded.lineages;
			const view = await evaluate(db, owner, version.number, seeded.mondays.moved);
			expect(view.grade).toBe('minor');
			expect(view.summary).toBe('1 heads-up this week');
			expect(view.notes).toEqual({
				[moved!]: {
					tone: 'caution',
					label: 'Heads-up',
					text: 'Heads-up · Heavy lower body the day before hard Muay Thai · You moved this here',
					why: `${WHY} You moved Lower A here from Friday.`
				},
				[hardMuayThai!]: {
					tone: 'caution',
					label: 'Heads-up',
					text: 'Heads-up · Heavy lower body the day before hard Muay Thai · After Lower A the day before',
					why: `${WHY} You moved Lower A here from Friday.`
				}
			});
		});
	});

	it('the week after is clear, and a skipped session is left out', async () => {
		await withRollback(async (db) => {
			const { owner, seeded, version } = await seed(db);
			expect(await evaluate(db, owner, version.number, seeded.mondays.clean)).toEqual({
				grade: 'clear',
				summary: 'No clashes this week',
				notes: {}
			});
			await skipSession(
				owner,
				{ sessionLineage: seeded.lineages.moved },
				{ version: version.number, today: TODAY },
				{ db }
			);
			const skipped = (await getCurrentProgram(owner, TODAY, { db }))!.version;
			expect(await evaluate(db, owner, skipped.number, seeded.mondays.moved)).toEqual({
				grade: 'clear',
				summary: 'No clashes this week',
				notes: {}
			});
		});
	});

	it('a clash whose day has passed is not shown: this week has none ahead', async () => {
		await withRollback(async (db) => {
			const { owner, seeded, version } = await seed(db);
			// Yesterday's Lower B, then Sparring, breaks same_day_order on a day already past.
			expect(seeded.lineages.passed).toBeDefined();
			expect(await evaluate(db, owner, version.number, seeded.mondays.current)).toEqual({
				grade: 'clear',
				summary: 'No clashes ahead this week',
				notes: {}
			});
			// Last week has ended: no week line.
			const past = await evaluate(db, owner, version.number, seeded.mondays.past);
			expect(past.summary).toBeNull();
			expect(past.notes).toEqual({});
		});
	});

	it('reads the owner’s own exercises’ traits, and shows at most three findings, avoid first', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const squat = await createCustomExercise(
				owner,
				{
					name: 'Garage rack squat',
					pattern: 'squat',
					primaryMuscles: ['quads'],
					measure: 'reps',
					loadType: 'external',
					tags: ['compound']
				},
				{ db }
			);
			// The hybrid's week 1, with Monday's lifts swapped for the owner's squat at RPE 8.
			const plan = programFixture('one-week', { monday: '2026-11-09', today: TODAY });
			const monday = plan.blocks[0]!.weeks[0]!.sessions[0]!;
			if (monday.kind !== 'strength') throw new Error('expected Monday’s strength session');
			monday.exercises = [
				{ ...monday.exercises[1]!, exercise: { customId: squat.id }, baselineLift: null }
			];
			monday.exercises[0]!.sets = monday.exercises[0]!.sets.map((set) => ({
				...set,
				targetRpe: 8,
				loadKind: 'rpe_based',
				loadValue: null
			}));
			// The same squat after Wednesday's intervals and on Friday, and a class on Saturday:
			// four avoid findings in all, so one of them is left out.
			const sessions = plan.blocks[0]!.weeks[0]!.sessions;
			const tuesday = sessions[1]!;
			sessions.push(
				{ ...monday, date: '2026-11-11', orderInDay: 2 },
				{ ...monday, date: '2026-11-13' },
				{ ...tuesday, date: '2026-11-14' }
			);
			await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
			const { version } = (await getCurrentProgram(owner, '2026-11-09', { db }))!;
			const view = await getWeekEvaluation(
				owner,
				{ version: version.number, weekStartsOn: '2026-11-09', today: '2026-11-09' },
				{ db }
			);
			// Monday's heavy squat (the owner's own exercise) before Tuesday's class, the intervals
			// after it, and Wednesday's squat before Thursday's class: Friday's is not shown.
			const texts = Object.values(view.notes).map((n) => n.text);
			expect(texts).toContain(
				'Heads-up · Heavy lower body the day before hard Muay Thai · The day before Muay Thai class'
			);
			expect(texts).toContain(
				'Heads-up · Intervals the day after a very demanding day · After Muay Thai class the day before'
			);
			expect(view.summary).toBe('3 heads-ups this week');
			// Monday, Tuesday, Wednesday's two and Thursday's class: none on Friday or Saturday.
			expect(Object.keys(view.notes)).toHaveLength(5);
		});
	});

	it('a clash across the weekend, from the Sunday before, is shown on the week’s Monday', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const plan = programFixture('hybrid', { monday: '2026-11-09', today: '2026-11-09' });
			const [baseline, week2] = [plan.blocks[0]!.weeks[0]!, plan.blocks[1]!.weeks[0]!];
			const tuesday = week2.sessions[1]!;
			if (tuesday.kind !== 'other') throw new Error('expected week 2’s Tuesday class');
			// Heavy squats on week 1's Sunday, and week 2's Monday evening a class.
			baseline.sessions.push({
				...week2.sessions[0]!,
				date: '2026-11-15',
				title: 'Sunday squats'
			});
			week2.sessions.push({ ...tuesday, date: '2026-11-16', orderInDay: 2 });
			await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
			const { version } = (await getCurrentProgram(owner, '2026-11-09', { db }))!;
			const view = await getWeekEvaluation(
				owner,
				{ version: version.number, weekStartsOn: '2026-11-16', today: '2026-11-09' },
				{ db }
			);
			expect(Object.values(view.notes).map((n) => n.text)).toContain(
				'Heads-up · Heavy lower body the day before hard Muay Thai · After Sunday squats the day before'
			);
		});
	});

	it('a session already done carries no note', async () => {
		await withRollback(async (db) => {
			const { owner, seeded, version } = await seed(db);
			const program = (await getCurrentProgram(owner, TODAY, { db }))!;
			const v2 = await getProgramVersion(owner, program.id, version.number, { db });
			const lowerA = v2.blocks[0]!.weeks[2]!.sessions.find(
				(s) => s.lineage === seeded.lineages.moved
			)!;
			// Lower A logged early, today: done, so only Tuesday's class keeps the note.
			const clientId = crypto.randomUUID();
			const startedAt = new Date(NOW.getTime() - 3_600_000).toISOString();
			await startWorkout(
				owner,
				{
					...{ clientId, kind: 'strength', discipline: 'strength', sessionType: 'strength' },
					...{ title: 'Lower A', plannedSessionId: lowerA.id, startedAt }
				},
				{ db }
			);
			await finishWorkout(
				owner,
				clientId,
				{
					status: 'completed',
					finishedAt: NOW.toISOString(),
					durationSeconds: 3600,
					sessionRpe: 8
				},
				{ db }
			);
			const view = await evaluate(db, owner, version.number, seeded.mondays.moved);
			expect(Object.keys(view.notes)).toEqual([seeded.lineages.hardMuayThai]);
			expect(view.summary).toBe('1 heads-up this week');
		});
	});

	it('another owner’s version is not found', async () => {
		await withRollback(async (db) => {
			const { seeded, version } = await seed(db);
			const other = await makeSecondOwner(db);
			await expect(
				evaluate(db, other, version.number, seeded.mondays.moved)
			).rejects.toBeInstanceOf(TrainingNotFoundError);
		});
	});
});

describe('Train’s load with the findings', () => {
	it('puts each note on its card, and the week line on planned weeks still ahead', async () => {
		await withRollback(async (db) => {
			const { owner, seeded } = await seed(db);
			const load = (week: number | null) =>
				loadTrainWeek(
					owner,
					{ now: NOW, week: week === null ? null : String(week), origin: origin() },
					{ db }
				).then(program);
			const moved = await load(FIXTURE_WEEKS.moved);
			expect(moved.weekLine).toBe('1 heads-up this week');
			const notes = moved.days.flatMap((d) => d.cards.filter((c) => c.note));
			expect(notes.map((c) => [c.lineage, c.note!.label])).toEqual([
				[seeded.lineages.moved, 'Heads-up'],
				[seeded.lineages.hardMuayThai, 'Heads-up']
			]);
			expect((await load(null)).weekLine).toBe('No clashes ahead this week');
			expect((await load(FIXTURE_WEEKS.clean)).weekLine).toBe('No clashes this week');
			expect((await load(FIXTURE_WEEKS.past)).weekLine).toBeNull();
			expect((await load(FIXTURE_WEEKS.outline)).weekLine).toBeNull();
		});
	});

	it('when the evaluation fails, the week renders without notes and the failure is recorded', async () => {
		const broken = unreachableDb();
		try {
			await withRollback(async (db) => {
				const { owner, seeded } = await seed(db);
				const request = origin();
				const data = program(
					await loadTrainWeek(
						owner,
						{ now: NOW, week: String(FIXTURE_WEEKS.moved), origin: request },
						{ db, errorsDb: db, periodisation: { db: broken.db } }
					)
				);
				expect(data.week).toMatchObject({ planned: true, startsOn: seeded.mondays.moved });
				expect(data.days.flatMap((d) => d.cards).length).toBeGreaterThan(0);
				expect(data.days.flatMap((d) => d.cards.filter((c) => c.note))).toEqual([]);
				expect(data.weekLine).toBeNull();
				const recorded = await findErrorsByRequestId(request.requestId, { db });
				expect(recorded).toHaveLength(1);
				expect(recorded[0]).toMatchObject({
					kind: 'load',
					status: 500,
					path: '/train',
					context: expect.objectContaining({ load: 'train', part: 'periodisation' })
				});
			});
		} finally {
			await broken.close();
		}
	});

	it('with periodisation off, nothing is evaluated', async () => {
		await withRollback(async (db) => {
			const { owner, seeded } = await seed(db);
			const data = program(
				await loadTrainWeek(
					owner,
					{ now: NOW, week: String(FIXTURE_WEEKS.moved), origin: origin() },
					{ db, periodisation: false }
				)
			);
			expect(data.week).toMatchObject({ startsOn: seeded.mondays.moved });
			expect(data.days.flatMap((d) => d.cards.filter((c) => c.note))).toEqual([]);
			expect(data.weekLine).toBeNull();
		});
	});
});

// The fixture's Monday maths: next week is this week's Monday plus 7.
it('the fixture names its weeks by their Mondays', async () => {
	await withRollback(async (db) => {
		const { seeded } = await seed(db);
		expect(seeded.mondays).toEqual({
			past: '2026-11-02',
			current: '2026-11-09',
			moved: '2026-11-16',
			clean: addDays('2026-11-16', 7),
			outline: '2026-11-30'
		});
	});
});
