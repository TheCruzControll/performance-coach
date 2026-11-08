/**
 * The start kit's substitution choices (services/workouts/kit.ts) on real Postgres, so 'Machine
 * unavailable', 'I don't like this', 'This hurts' and a substitute's prefill work offline:
 * - M3's alternatives keep the pattern and intent and respect equipment, injuries and dislikes,
 *   each with its reasons, its load type, what it needs and its own last top set
 * - why nothing fits, when nothing does
 * - per body area, the gentler options (domain/programming/pain.ts), never the original
 * - the query count does not grow with the session
 */
import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { addDays } from '../../../src/lib/domain/calendar';
import { CATALOGUE } from '../../../src/lib/domain/exercises/index';
import { BODY_AREAS } from '../../../src/lib/domain/profile/catalog';
import type { ProgramPlan, StrengthSessionPlan } from '../../../src/lib/domain/training/types';
import type {
	KitAlternative,
	KitExercise,
	StrengthKit
} from '../../../src/lib/domain/workout/index';
import type { Executor } from '../../../src/lib/server/db';
import {
	saveEquipment,
	saveExercisePreferences,
	saveInjuries
} from '../../../src/lib/server/services/profile';
import {
	createProgramFromPlan,
	getProgramVersion,
	type StoredSession
} from '../../../src/lib/server/services/programs/index';
import { kitForLineage } from '../../../src/lib/server/services/workouts/kit';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';
import { exerciseIds, logStrength, utc } from '../training/fixtures/history';

const MONDAY = '2026-11-09';
const TODAY = '2026-11-11';
const NOW = new Date(`${TODAY}T08:00:00Z`);
const deps = (db: Executor) => ({ db, now: () => NOW });
const byKey = new Map(CATALOGUE.map((e) => [e.key, e]));

/** The 'workout-day' plan, with `edit` applied to today's strength session. */
function workoutDay(edit?: (session: StrengthSessionPlan) => void): ProgramPlan {
	const plan = programFixture('workout-day', { monday: MONDAY, today: TODAY });
	const session = plan.blocks[0]!.weeks[0]!.sessions.find((s) => s.kind === 'strength');
	edit?.(session as StrengthSessionPlan);
	return plan;
}

/** Stores `plan` for `owner` and returns the kit of week 1's first strength session. */
async function kitOf(db: Executor, owner: string, plan: ProgramPlan): Promise<StrengthKit> {
	const { programId } = await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
	const v1 = await getProgramVersion(owner, programId, 1, { db });
	const sessions = v1.blocks[0]!.weeks[0]!.sessions as StoredSession[];
	const strength = sessions.find((s) => s.kind === 'strength')!;
	const kit = await kitForLineage(owner, strength.lineage, deps(db));
	if (kit?.kind !== 'strength') throw new Error('a strength kit');
	return kit;
}

const entry = (kit: StrengthKit, key: string): KitExercise =>
	kit.exercises.find((e) => e.exercise.key === key)!;
const keys = (options: readonly KitAlternative[] | undefined) =>
	(options ?? []).map((a) => a.exercise.key!);
/** Every exercise a kit entry offers: its alternatives and every area's gentler options. */
const everyOffered = (e: KitExercise) => [
	...keys(e.alternatives),
	...Object.values(e.gentler ?? {}).flatMap(keys)
];

const equipment = (db: Executor, owner: string, items: string[]) =>
	saveEquipment(
		owner,
		{ gymType: items.length ? null : 'none', equipment: items, homeEquipment: [], notes: null },
		{ db }
	);

describe('the kit’s alternatives', () => {
	it('gives back squat dumbbell squat-pattern alternatives when the owner has only dumbbells', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await equipment(db, owner, ['dumbbells']);
			const squat = entry(await kitOf(db, owner, workoutDay()), 'back_squat');
			const found = keys(squat.alternatives);
			expect(found).toEqual(expect.arrayContaining(['goblet_squat', 'dumbbell_front_squat']));
			expect(squat.blocked).toEqual([]);
			for (const alternative of squat.alternatives!) {
				const meta = byKey.get(alternative.exercise.key!)!;
				expect(['squat', 'lunge']).toContain(meta.pattern);
				expect(alternative.equipment.every((item) => item === 'dumbbells')).toBe(true);
				expect(alternative.equipment).toEqual(meta.equipment);
			}
			// The substitution group comes before the related patterns.
			const group = squat.alternatives!.map((a) => a.reasons[0]!.startsWith('Does the same job'));
			expect(group[0]).toBe(true);
			expect(group).toEqual([...group].sort((a, b) => Number(b) - Number(a)));
		});
	});

	it('offers nothing for the hybrid power clean with bodyweight only, and says it needs a barbell', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await equipment(db, owner, []);
			const plan = programFixture('hybrid', { monday: MONDAY, today: TODAY });
			const clean = entry(await kitOf(db, owner, plan), 'power_clean');
			expect(clean.alternatives).toEqual([]);
			expect(clean.blocked).toHaveLength(1);
			expect(clean.blocked![0]).toMatch(/^Needs a barbell\b/);
		});
	});

	it('never offers a disliked exercise, as an alternative or a gentler option', async () => {
		let first = '';
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const before = entry(await kitOf(db, owner, workoutDay()), 'back_squat');
			first = keys(before.alternatives)[0]!;
			expect(everyOffered(before)).toContain(first);
		});
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await saveExercisePreferences(
				owner,
				{ items: [{ exercise: byKey.get(first)!.name, sentiment: 'dislike' }] },
				{ db }
			);
			const after = entry(await kitOf(db, owner, workoutDay()), 'back_squat');
			expect(after.alternatives!.length).toBeGreaterThan(0);
			expect(everyOffered(after)).not.toContain(first);
		});
	});

	it('removes overhead pressing for a moderate shoulder injury', async () => {
		const plan = workoutDay((session) => {
			session.exercises[1] = { ...session.exercises[1]!, exercise: { key: 'overhead_press' } };
		});
		const overhead = (e: KitExercise) =>
			everyOffered(e).filter((key) => byKey.get(key)!.tags.includes('overhead'));
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const sound = entry(await kitOf(db, owner, plan), 'overhead_press');
			expect(overhead(sound).length).toBeGreaterThan(0);
		});
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await saveInjuries(
				owner,
				{
					injuries: [
						{ bodyArea: 'shoulder', side: 'left', severity: 'moderate', avoid: [], active: true }
					]
				},
				{ db }
			);
			const press = entry(await kitOf(db, owner, plan), 'overhead_press');
			expect(overhead(press)).toEqual([]);
			expect(keys(press.alternatives)).toContain('landmine_press');
		});
	});

	it("keeps leg press's alternatives in the squat pattern", async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const legPress = entry(await kitOf(db, owner, workoutDay()), 'leg_press');
			expect(legPress.alternatives!.length).toBeGreaterThan(0);
			expect(legPress.alternatives![0]!.exercise.pattern).toBe('squat');
			for (const a of legPress.alternatives!) {
				expect(['squat', 'lunge']).toContain(a.exercise.pattern);
			}
		});
	});

	it("includes the assisted pull-up among the pull-up's, loading as assisted", async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const pullUp = entry(await kitOf(db, owner, workoutDay()), 'pull_up');
			const assisted = pullUp.alternatives!.find((a) => a.exercise.key === 'assisted_pull_up');
			expect(assisted?.exercise).toMatchObject({ loadType: 'assisted', pattern: 'vertical_pull' });
		});
	});

	it('gives each alternative its reasons, and its own last top set when it has one', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const ids = await exerciseIds(db, ['leg_press', 'goblet_squat'] as const);
			await logStrength(db, owner, { startedAt: utc(addDays(TODAY, -3), '17:00') }, [
				{ exercise: ids.leg_press, weight: 100, reps: 10, warmup: true },
				{ exercise: ids.leg_press, weight: 150, reps: 6, rpe: 8 },
				{ exercise: ids.leg_press, weight: 140, reps: 8, rpe: 8 }
			]);
			const squat = entry(await kitOf(db, owner, workoutDay()), 'back_squat');
			const alternatives = squat.alternatives!;
			for (const a of alternatives) {
				expect(a.reasons.length, a.exercise.key!).toBeGreaterThan(0);
				expect(a.exercise.id).toMatch(/^[0-9a-f-]{36}$/);
			}
			const legPress = alternatives.find((a) => a.exercise.id === ids.leg_press)!;
			expect(legPress.reasons).toEqual(['Does the same job as back squat']);
			expect(legPress.lastTopSet).toEqual({
				date: addDays(TODAY, -3),
				reps: 6,
				seconds: null,
				metres: null,
				weight: 150,
				assistance: null,
				unit: 'kg',
				rpe: 8,
				missedReps: 0,
				isWarmup: false,
				isExtra: false
			});
			const goblet = alternatives.find((a) => a.exercise.id === ids.goblet_squat)!;
			expect(goblet.lastTopSet).toBeNull();
		});
	});
});

describe('the kit’s gentler options', () => {
	it('lists each body area, never the original, each option with why it is gentler', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const kit = await kitOf(db, owner, workoutDay());
			for (const e of kit.exercises) {
				expect(Object.keys(e.gentler!).sort()).toEqual([...BODY_AREAS].sort());
				expect(everyOffered(e)).not.toContain(e.exercise.key);
			}
			const squat = entry(kit, 'back_squat');
			const back = squat.gentler!.lower_back!;
			expect(back.length).toBeGreaterThan(0);
			for (const option of back) {
				expect(option.exercise.tags).not.toContain('spinal_loading');
			}
			expect(back[0]!.reasons).toEqual([
				'Less load and impact',
				'Guided by a machine or cable',
				'Does the same job as back squat'
			]);
		});
	});
});

describe('the kit’s query count', () => {
	it('is the same for a two-exercise and a six-exercise session', async () => {
		const two = workoutDay((session) => {
			// The back squat and the pull-up: one of them competes for most reps, as in the six.
			session.exercises = [session.exercises[0]!, { ...session.exercises[3]!, superset: null }];
		});
		const six = workoutDay((session) => {
			session.exercises.push({ ...session.exercises[2]!, exercise: { key: 'barbell_row' } });
		});
		const counts: number[] = [];
		for (const plan of [two, six]) {
			await withRollback(async (db) => {
				const owner = await makeOwner(db);
				const { programId } = await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
				const v1 = await getProgramVersion(owner, programId, 1, { db });
				const strength = (v1.blocks[0]!.weeks[0]!.sessions as StoredSession[]).find(
					(s) => s.kind === 'strength'
				)!;
				const spy = vi.spyOn(pg.Client.prototype, 'query');
				try {
					const kit = await kitForLineage(owner, strength.lineage, deps(db));
					expect(kit?.kind === 'strength' && kit.exercises.length).toBe(plan === two ? 2 : 6);
					counts.push(
						spy.mock.calls
							.map(([q]) => (typeof q === 'string' ? q : (q as { text: string }).text))
							.filter((text) => !/^\s*(begin|commit|rollback|savepoint|release)\b/i.test(text))
							.length
					);
					console.info(`kit of ${plan === two ? 2 : 6}: ${JSON.stringify(kit).length} bytes`);
				} finally {
					spy.mockRestore();
				}
			});
		}
		// The session and its children (3), the profile, the owner's programming input (18: the
		// training profile's sections, custom exercises and preferences), the exercises, the
		// alternatives by key, then the four batched history reads.
		expect(counts).toEqual([30, 30]);
	});
});
