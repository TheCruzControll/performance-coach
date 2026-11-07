/**
 * The coaching memory's profile half on real Postgres (src/lib/server/services/coach/memory.ts):
 * - goals by rank, the active program at its version, week and phase, the last 14 days planned
 *   against done, baselines measured and estimated, trends, preferences with their source and
 *   reason, equipment, active injuries and the movements they say to avoid
 * - only explicit preferences: a machine being taken is a substitution, never a preference
 * - the snapshot opens each new conversation from the records, never from another thread's chat,
 *   and the segment records the program version it starts on
 * - at most MEMORY_PROFILE_QUERIES queries, one at a time (the integration setup fails overlaps)
 */
import { eq } from 'drizzle-orm';
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { addDays } from '../../../src/lib/domain/calendar';
import type { MemorySnapshot } from '../../../src/lib/domain/coach/memory';
import { BODY_AREA_LABEL, EQUIPMENT_LABEL } from '../../../src/lib/domain/profile/catalog';
import { MEMORY_HEADER } from '../../../src/lib/server/agent/prompt/context';
import { coachThreads, workoutSubstitutions, type Executor } from '../../../src/lib/server/db';
import {
	getCoachingMemory,
	MEMORY_PROFILE_QUERIES,
	RECENT_DAYS
} from '../../../src/lib/server/services/coach/memory';
import {
	createGoal,
	saveBaselines,
	saveEquipment,
	saveInjuries
} from '../../../src/lib/server/services/profile';
import {
	createProgramFromPlan,
	getProgramVersion,
	skipSession
} from '../../../src/lib/server/services/programs/index';
import { recordExercisePreference } from '../../../src/lib/server/services/training/preferences';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { withRollback } from '../helpers';
import { eventGoal, generalGoal, makeOwner } from '../profile/fixtures';
import { exerciseIds, logOther, utc } from '../training/fixtures/history';
import { runScripted, storedRows, TURN_NOW } from './harness';

/** The harness's day: Wednesday of the program's week 1 (Monday 9 November 2026). */
const MONDAY = '2026-11-09';
const TODAY = '2026-11-11';
expect(TURN_NOW.startsWith(TODAY)).toBe(true);

const answering = { name: 'answer', matches: () => true, steps: [{ text: '[note] Noted.' }] };

/** The statements `run` sends, less transaction control (BEGIN, SAVEPOINT …). */
async function statementsOf(run: () => Promise<unknown>): Promise<string[]> {
	const spy = vi.spyOn(pg.Client.prototype, 'query');
	try {
		await run();
		return spy.mock.calls
			.map(([query]) => (typeof query === 'string' ? query : (query as { text: string }).text))
			.filter((text) => !/^\s*(begin|commit|rollback|savepoint|release)\b/i.test(text));
	} finally {
		spy.mockRestore();
	}
}

/**
 * Eight complete weeks before this one: a class a week for four weeks, then three a week, so
 * every trend rises. Returns the workouts by day.
 */
async function logWeeks(db: Executor, owner: string) {
	const ids = new Map<string, string>();
	const first = addDays(MONDAY, -56);
	for (let week = 0; week < 8; week++) {
		for (const day of week < 4 ? [0] : [0, 2, 4]) {
			const date = addDays(first, 7 * week + day);
			const id = await logOther(db, owner, {
				startedAt: utc(date, '18:00'),
				title: `Class ${date}`,
				durationSeconds: 3600,
				sessionRpe: 7
			});
			ids.set(date, id);
		}
	}
	return ids;
}

/** An owner with a profile, a program, two months of training and a coach-recorded dislike. */
async function seed(db: Executor) {
	const owner = await makeOwner(db);
	const { leg_press, back_squat, hack_squat } = await exerciseIds(db, [
		'leg_press',
		'back_squat',
		'hack_squat'
	]);
	const general = await createGoal(owner, generalGoal(), { db });
	const event = await createGoal(owner, eventGoal(), { db });
	const { lifts } = await saveBaselines(
		owner,
		{
			unknown: false,
			lifts: [
				{ lift: 'back_squat', source: 'tested', value: 185, unit: 'kg', achievedOn: '2026-10-01' },
				{
					lift: 'bench_press',
					source: 'set',
					unit: 'kg',
					setWeight: 100,
					setReps: 5,
					setRpe: 8,
					achievedOn: '2026-10-30'
				}
			]
		},
		{ db }
	);
	await saveEquipment(
		owner,
		{
			gymType: 'commercial',
			equipment: ['squat_rack', 'barbell'],
			homeEquipment: ['dumbbells', 'barbell'],
			notes: null
		},
		{ db }
	);
	const [knee] = await saveInjuries(
		owner,
		{
			injuries: [
				{
					bodyArea: 'knee',
					side: 'left',
					severity: 'moderate',
					notes: 'Flares after running downhill',
					avoid: ['Deep lunges', 'Box jumps'],
					active: true
				},
				{ bodyArea: 'shoulder', side: 'right', severity: 'mild', avoid: ['Dips'], active: false }
			]
		},
		{ db }
	);
	const dislike = await recordExercisePreference(
		owner,
		{ exerciseId: leg_press, sentiment: 'dislike', reason: 'Hurts my lower back', source: 'coach' },
		{ db }
	);
	const workouts = await logWeeks(db, owner);
	const plan = programFixture('hybrid', { monday: MONDAY, today: TODAY });
	const { programId, versionId } = await createProgramFromPlan(
		owner,
		plan,
		{ source: 'rules' },
		{ db }
	);
	const v1 = await getProgramVersion(owner, programId, 1, { db });
	const sessions = v1.blocks[0]!.weeks[0]!.sessions;
	const monday = sessions.find((s) => s.date === MONDAY)!;
	const logged = await logOther(db, owner, {
		startedAt: utc(MONDAY, '18:00'),
		title: 'Monday, done',
		planned: { sessionId: monday.id, lineageId: monday.lineage, programId }
	});
	workouts.set(MONDAY, logged);
	// A machine that was taken: a swap on the workout, which must never read as a preference.
	await db.insert(workoutSubstitutions).values({
		ownerId: owner,
		clientMutationId: crypto.randomUUID(),
		workoutId: logged,
		exercisePosition: 1,
		fromExerciseId: back_squat,
		toExerciseId: hack_squat,
		reason: 'equipment_unavailable'
	});
	return {
		owner,
		general,
		event,
		lifts,
		knee: knee!,
		dislike,
		workouts,
		v1,
		versionId,
		sessions
	};
}

/** The memory a stored preamble carries. */
function preambleMemory(content: unknown): Record<string, unknown> {
	const [block] = content as { type: string; text: string }[];
	const [header, json] = block!.text.split('\n');
	expect(header).toBe(MEMORY_HEADER);
	return (JSON.parse(json!) as { memory: Record<string, unknown> }).memory;
}

describe('getCoachingMemory: the profile half', () => {
	it('lists goals, the program, the recent days, baselines, trends, preferences and constraints', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const memory = await getCoachingMemory(s.owner, { today: TODAY }, { db });

			expect(memory.asOf).toBe(TODAY);
			expect(memory.profile.goals).toEqual([
				{
					rank: 1,
					title: s.general.title,
					targetDate: null,
					source: { type: 'goal', id: s.general.id }
				},
				{
					rank: 2,
					title: s.event.title,
					targetDate: '2027-03-14',
					source: { type: 'goal', id: s.event.id }
				}
			]);
			expect(memory.profile.program).toEqual({
				name: s.v1.title,
				versionNumber: 1,
				week: 1,
				weeks: expect.any(Number),
				phase: s.v1.blocks[0]!.phase,
				source: { type: 'version', id: '1' }
			});

			// A coach-sourced dislike keeps its source and reason.
			expect(memory.profile.preferences).toEqual([
				{
					exercise: s.dislike.exercise,
					stance: 'dislike',
					origin: 'coach',
					reason: 'Hurts my lower back',
					source: { type: 'preference', id: s.dislike.id }
				}
			]);

			// Measured and estimated maxes stay apart.
			const squat = s.lifts.find((l) => l.lift === 'back_squat')!;
			const bench = s.lifts.find((l) => l.lift === 'bench_press')!;
			expect(memory.profile.baselines).toEqual([
				{
					exercise: 'Back squat',
					value: 185,
					unit: 'kg',
					kind: 'measured',
					date: '2026-10-01',
					source: { type: 'baseline', id: squat.id }
				},
				{
					exercise: 'Bench press',
					value: bench.value,
					unit: 'kg',
					kind: 'estimated',
					date: '2026-10-30',
					source: { type: 'baseline', id: bench.id }
				}
			]);

			// One a week, then three: every trend over the eight complete weeks rises.
			expect(memory.profile.trends.map((t) => [t.subject, t.direction])).toEqual([
				['completed workouts per week', 'up'],
				['minutes of completed workouts per week', 'up'],
				['sRPE load (minutes × session RPE) of completed workouts per week', 'up']
			]);
			expect(memory.profile.trends[0]).toMatchObject({
				summary: '1 to 3 sessions a week (+200%), weeks of 2026-09-14 to 2026-11-02',
				source: { type: 'date', id: '2026-09-14' }
			});

			// Gym equipment, then what is only at home; active injuries and what they rule out.
			expect(memory.profile.equipment.map((e) => e.name)).toEqual([
				EQUIPMENT_LABEL.barbell,
				EQUIPMENT_LABEL.squat_rack,
				`${EQUIPMENT_LABEL.dumbbells} (home)`
			]);
			const kneeRef = { type: 'preference', id: `injury.${s.knee.id}` };
			expect(memory.profile.injuries).toEqual([
				{
					area: 'knee',
					severity: 'moderate',
					note: 'Flares after running downhill',
					source: kneeRef
				}
			]);
			expect(memory.profile.avoid).toEqual([
				{ movement: 'Deep lunges', reason: `${BODY_AREA_LABEL.knee} injury`, source: kneeRef },
				{ movement: 'Box jumps', reason: `${BODY_AREA_LABEL.knee} injury`, source: kneeRef }
			]);
			expect(Object.values(memory.records).every((section) => section.length === 0)).toBe(true);
		});
	});

	it('sets the last 14 days planned against done, newest first', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			// A skipped session is no longer planned (version 2 skips today's).
			const skipped = s.sessions.filter((session) => session.date === TODAY);
			for (const session of skipped)
				await skipSession(
					s.owner,
					{ sessionLineage: session.lineage },
					{ version: 1, today: TODAY },
					{ db }
				);
			const { recentDays } = (await getCoachingMemory(s.owner, { today: TODAY }, { db })).profile;
			const from = addDays(TODAY, 1 - RECENT_DAYS);
			const planned = (date: string) =>
				s.sessions
					.filter((session) => session.date === date)
					.map((session) => ({
						title: session.title,
						source: { type: 'session', id: session.lineage, date }
					}));
			const done = (date: string, title = `Class ${date}`) => [
				{ title, source: { type: 'workout', id: s.workouts.get(date)!, date } }
			];
			const day = (date: string, d: MemorySnapshot['profile']['recentDays'][number]['done']) => ({
				date,
				planned: planned(date),
				done: d,
				source: { type: 'date', id: date }
			});
			expect(recentDays).toEqual([
				day('2026-11-10', []),
				day(MONDAY, done(MONDAY, 'Monday, done')),
				day('2026-11-06', done('2026-11-06')),
				day('2026-11-04', done('2026-11-04')),
				day('2026-11-02', done('2026-11-02')),
				day('2026-10-30', done('2026-10-30'))
			]);
			expect(recentDays.every((d) => d.date >= from && d.date <= TODAY)).toBe(true);
			expect(skipped.length).toBeGreaterThan(0);
			expect(planned(MONDAY).length).toBeGreaterThan(0);
		});
	});

	it('never lists a machine being taken (equipment_unavailable) under preferences', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { back_squat, hack_squat } = await exerciseIds(db, ['back_squat', 'hack_squat']);
			const workoutId = await logOther(db, owner, { startedAt: utc(MONDAY, '07:00') });
			for (const reason of ['equipment_unavailable', 'situational'] as const)
				await db.insert(workoutSubstitutions).values({
					ownerId: owner,
					clientMutationId: crypto.randomUUID(),
					workoutId,
					exercisePosition: 1,
					fromExerciseId: back_squat,
					toExerciseId: hack_squat,
					reason
				});

			const memory = await getCoachingMemory(owner, { today: TODAY }, { db });
			expect(memory.profile.preferences).toEqual([]);
			expect(JSON.stringify(memory)).not.toMatch(/equipment_unavailable|Hack squat|hack_squat/i);
		});
	});

	it('has no program, and nothing planned, without an active program', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const workout = await logOther(db, owner, {
				startedAt: utc('2026-11-10', '18:00'),
				title: 'Muay Thai'
			});
			const memory = await getCoachingMemory(owner, { today: TODAY }, { db });
			expect(memory.profile.program).toBeNull();
			expect(memory.profile.recentDays).toEqual([
				{
					date: '2026-11-10',
					planned: [],
					done: [
						{ title: 'Muay Thai', source: { type: 'workout', id: workout, date: '2026-11-10' } }
					],
					source: { type: 'date', id: '2026-11-10' }
				}
			]);
			// Too little history for a trend is no trend, never a zero.
			expect(memory.profile.trends).toEqual([]);
			expect(memory.profile.goals).toEqual([]);
		});
	});

	it(`sends at most ${MEMORY_PROFILE_QUERIES} queries`, async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const sent = await statementsOf(() => getCoachingMemory(s.owner, { today: TODAY }, { db }));
			expect(MEMORY_PROFILE_QUERIES).toBe(9);
			expect(sent.length).toBeLessThanOrEqual(MEMORY_PROFILE_QUERIES);
		});
	});
});

describe('the memory across conversations', () => {
	it('opens each new thread with a fresh snapshot from the records, and records its version', async () => {
		await withRollback(async (db) => {
			const s = await seed(db);
			const first = await runScripted(answering, { db, owner: s.owner, text: 'Plan my week' });
			// Recorded after the first thread began: its preamble stays as it was.
			const { leg_extension } = await exerciseIds(db, ['leg_extension']);
			const later = await recordExercisePreference(
				s.owner,
				{ exerciseId: leg_extension, sentiment: 'dislike', reason: 'Knee', source: 'coach' },
				{ db }
			);
			const second = await runScripted(answering, { db, owner: s.owner, text: 'New question' });
			expect(second.threadId).not.toBe(first.threadId);

			const [firstRows, secondRows] = [
				await storedRows(db, first.threadId!),
				await storedRows(db, second.threadId!)
			];
			const before = preambleMemory(firstRows[0]!.content) as {
				profile: { preferences: { source: { id: string } }[]; program: unknown };
			};
			const after = preambleMemory(secondRows[0]!.content) as typeof before;
			expect(before.profile.preferences.map((p) => p.source.id)).toEqual([s.dislike.id]);
			expect(after.profile.preferences.map((p) => p.source.id)).toEqual([s.dislike.id, later.id]);
			// What the coach knows comes from the records: the new thread holds none of the old chat.
			expect(JSON.stringify(secondRows.map((row) => row.content))).not.toContain('Plan my week');
			expect(secondRows.map((row) => row.kind)).toEqual([
				'segment_preamble',
				'owner_message',
				'context',
				'assistant'
			]);

			// The segment records the program version its snapshot shows.
			const [thread] = await db
				.select({ version: coachThreads.segmentProgramVersionId })
				.from(coachThreads)
				.where(eq(coachThreads.id, second.threadId!));
			expect(thread!.version).toBe(s.versionId);
			expect(after.profile.program).toMatchObject({ versionNumber: 1, source: { id: '1' } });
		});
	});
});
