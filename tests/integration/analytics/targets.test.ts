/**
 * Muscle-group targets (src/lib/server/services/analytics/targets.ts) on the M6 dataset: each
 * week's range comes from the input that generated its block, scaled by its volume factor, beside
 * the week's planned hard sets; today's profile never rewrites a past week. An M7 week
 * (periodised-targets) reads the band the generator used: its own setsPerGroup, or the volume
 * stage's band for the strength goal's mode from the goals as prepare ranked them; a block from a
 * generator before M7's keeps M6's rule.
 */
import { and, eq, sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { addDays } from '../../../src/lib/domain/calendar';
import { CATALOGUE } from '../../../src/lib/domain/exercises/index';
import {
	exerciseRefKey,
	plannedHardSets,
	type ExerciseMuscles
} from '../../../src/lib/domain/training/metrics';
import type { WeekPlan } from '../../../src/lib/domain/training/types';
import { M7_SCENARIOS } from '../../../src/lib/domain/programming/periodisation/scenarios';
import type { M7ScenarioKey } from '../../../src/lib/domain/programming/periodisation/scenarios';
import { SCENARIO_START } from '../../../src/lib/domain/programming/scenarios';
import type { TrainingProfile } from '../../../src/lib/domain/profile/types';
import type { DecisionPlan } from '../../../src/lib/domain/training/types';
import type { Executor } from '../../../src/lib/server/db';
import {
	defaultLabel,
	doseLabel,
	getMuscleTargets,
	NO_STORED_TARGET,
	NO_STRENGTH_TARGET,
	ownRangeLabel,
	secondaryLabel,
	STORED_TARGET,
	type WeekTarget
} from '../../../src/lib/server/services/analytics/targets';
import { programVersions } from '../../../src/lib/server/db/schema/programs';
import { listGoals, saveBody, updateGoal } from '../../../src/lib/server/services/profile/index';
import {
	createProgramFromPlan,
	getProgramVersion
} from '../../../src/lib/server/services/programs/index';
import { programFixture } from '../../../src/lib/server/test-support/program-fixtures';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';
import { LAST_DAY, seedDataset, WEEK_ONE, weekOf } from './fixtures/dataset';
import { storeM7Program } from './fixtures/m7-programs';

const MUSCLES = new Map<string, ExerciseMuscles>(
	CATALOGUE.map((e) => [exerciseRefKey({ key: e.key }), e])
);

const byWeek = (weeks: WeekTarget[]) => new Map(weeks.map((w) => [w.weekStart, w]));

describe('muscle-group targets', () => {
	it("judge each week by its block's stored input, scaled by the week's volume factor", async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const weeks = byWeek(
				await getMuscleTargets(data.owner, { from: WEEK_ONE, to: LAST_DAY }, { db })
			);
			expect(weeks.size).toBe(16);

			// Program A was built on a cut: four fifths of 10–20.
			for (const n of [1, 2, 3, 4, 5, 6]) {
				expect(weeks.get(weekOf(n))).toMatchObject({
					source: 'block',
					label: STORED_TARGET,
					programId: data.programs.a,
					volumeFactor: 1,
					band: 'the 8–16 that suits building muscle on a cut'
				});
				expect(weeks.get(weekOf(n))!.targets.chest).toEqual([8, 16]);
			}
			// Program B, no phase: 10–20 at full volume, 6–12 in B1's 0.6 deload.
			for (const n of [7, 8, 9, 10, 12, 16]) {
				expect(weeks.get(weekOf(n))!.programId).toBe(data.programs.b);
				expect(weeks.get(weekOf(n))!.targets.chest).toEqual([10, 20]);
			}
			const deload = weeks.get(weekOf(11))!;
			expect(deload).toMatchObject({ volumeFactor: 0.6, source: 'block' });
			expect(deload.targets).toMatchObject({ chest: [6, 12], quads: [6, 12], back: [6, 12] });
			// Major groups only: the curls' biceps sets are planned, with no target.
			expect(deload.planned!.groups.biceps).toBeGreaterThan(0);
			expect(deload.targets.biceps).toBeUndefined();
			expect(Object.keys(deload.targets).sort()).toEqual([
				'back',
				'chest',
				'hamstrings',
				'hips',
				'quads',
				'shoulders'
			]);
		});
	});

	it("draw the planned line as plannedHardSets of the current version's week", async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const weeks = byWeek(
				await getMuscleTargets(data.owner, { from: WEEK_ONE, to: LAST_DAY }, { db })
			);
			const a = await getProgramVersion(data.owner, data.programs.a, 2, { db });
			const b = await getProgramVersion(data.owner, data.programs.b, 2, { db });
			for (const week of [...a.blocks, ...b.blocks].flatMap((block) => block.weeks)) {
				if (week.startsOn > LAST_DAY) continue;
				const expected = plannedHardSets(week as unknown as WeekPlan, MUSCLES);
				expect(weeks.get(week.startsOn)!.planned).toEqual(expected);
			}
			// Version 2's week 3 benches 4 working sets; the weeks around it 3.
			expect(weeks.get(weekOf(2))!.planned!.groups.chest).toBe(3);
			expect(weeks.get(weekOf(3))!.planned!.groups.chest).toBe(4);
		});
	});

	it("keep past weeks' targets when today's goal turns to strength and the phase to bulk", async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const range = { from: addDays(WEEK_ONE, -7), to: LAST_DAY };
			const before = await getMuscleTargets(data.owner, range, { db });
			expect(before[0]).toMatchObject({
				source: 'default',
				label: defaultLabel('hypertrophy'),
				programId: null,
				planned: null,
				volumeFactor: 1
			});
			expect(before[0]!.targets.chest).toEqual([10, 20]);

			const [goal] = await listGoals(data.owner, { db });
			await updateGoal(
				data.owner,
				goal!.id,
				{
					kind: 'general',
					title: 'Get stronger',
					disciplines: ['strength'],
					focus: 'Squat, bench and deadlift',
					measure: 'Top sets week on week'
				},
				{ db }
			);
			await saveBody(
				data.owner,
				{ weightUnit: 'kg', bodyWeight: 84, nutritionPhase: 'bulk' },
				{ db }
			);

			const after = await getMuscleTargets(data.owner, range, { db });
			// The week no program plans follows today's profile; every program week stays.
			expect(after[0]).toMatchObject({ label: defaultLabel('strength') });
			expect(after[0]!.targets.chest).toEqual([8, 14]);
			expect(after.slice(1)).toEqual(before.slice(1));
		});
	});

	it("read an edit version's block from its generated ancestor's input", async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const v2 = await getProgramVersion(data.owner, data.programs.b, 2, { db });
			expect(v2.version).toMatchObject({ current: true, generator: null, inputSnapshot: null });
			const weeks = await getMuscleTargets(data.owner, { from: weekOf(12), to: LAST_DAY }, { db });
			expect(weeks).toHaveLength(5);
			for (const week of weeks) {
				expect(week).toMatchObject({ source: 'block', programId: data.programs.b });
				expect(week.targets.hamstrings).toEqual([10, 20]);
			}
		});
	});

	it('read a block from the lowest generated version that plans it, not a later one', async () => {
		await withRollback(async (db) => {
			const data = await seedDataset(db);
			const v1 = await getProgramVersion(data.owner, data.programs.b, 1, { db });
			const snapshot = v1.version.inputSnapshot as Record<string, unknown>;
			expect(snapshot).toMatchObject({ nutritionPhase: null });
			// Version 2 as if a later generator had rebuilt it on a cut: B's blocks keep version 1's.
			// Versions are immutable; the guard is lifted inside this rolled-back transaction only.
			await db.execute(
				sql`alter table program_versions disable trigger program_versions_refuse_update`
			);
			await db
				.update(programVersions)
				.set({
					generator: v1.version.generator,
					inputSnapshot: { ...snapshot, nutritionPhase: 'cut' }
				})
				.where(and(eq(programVersions.programId, data.programs.b), eq(programVersions.number, 2)));
			const weeks = await getMuscleTargets(data.owner, { from: weekOf(12), to: LAST_DAY }, { db });
			expect(weeks).toHaveLength(5);
			for (const week of weeks) expect(week.targets.chest).toEqual([10, 20]);
		});
	});

	it('show only the planned line for a program no generator built', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const monday = '2026-11-02';
			const plan = programFixture('hybrid', { monday, today: monday });
			const { programId } = await createProgramFromPlan(owner, plan, { source: 'rules' }, { db });
			const weeks = await getMuscleTargets(owner, { from: monday, to: addDays(monday, 6) }, { db });
			expect(weeks).toEqual([
				{
					...{ weekStart: monday, source: 'none', label: NO_STORED_TARGET, programId },
					...{ volumeFactor: 1, targets: {}, band: null },
					blockLineage: expect.any(String),
					planned: expect.objectContaining({ weekStart: monday })
				}
			]);
			expect(Object.keys(weeks[0]!.planned!.groups).length).toBeGreaterThan(0);
		});
	});
});

/** S9's runner-lifter with its ranks swapped: strength first, the week-16 marathon second. */
const strengthFirst = () => {
	const profile = M7_SCENARIOS.runnerLifter();
	return { ...profile, goals: profile.goals.map((g) => ({ ...g, priority: 3 - g.priority! })) };
};

/** The M7 program of `profile` stored for a new owner, and its first block's week targets. */
async function m7Targets(db: Executor, profile: TrainingProfile, generator?: string) {
	const owner = await makeOwner(db);
	const stored = await storeM7Program(db, owner, profile, SCENARIO_START, generator);
	const block = stored.version.blocks[0]!;
	const range = { from: block.startsOn, to: block.endsOn };
	const weeks = await getMuscleTargets(owner, range, { db });
	return { ...stored, block, weeks };
}

const chestOf = (weeks: WeekTarget[]) => weeks.map((w) => w.targets.chest);
/** The [lo, hi] of 'N–M hard sets' in a maintenance_dose decision's dose words. */
const doseSets = (d: DecisionPlan) => {
	const [, lo, hi] = /(\d+)–(\d+) hard sets/.exec(String(d.evidence.dose))!;
	return [Number(lo), Number(hi)];
};

describe('muscle-group targets of M7 weeks', () => {
	it("read a hypertrophy block's own rising range, unscaled, and its deload's scaled", async () => {
		await withRollback(async (db) => {
			const { weeks } = await m7Targets(db, M7_SCENARIOS.hypertrophyBlock());
			expect(chestOf(weeks)).toEqual([
				[10, 12],
				[12, 14],
				[14, 16],
				[16, 18],
				[6, 7.2]
			]);
			expect(weeks[1]).toMatchObject({
				source: 'block',
				label: ownRangeLabel([12, 14]),
				volumeFactor: 1,
				band: 'the 12–14 this block plans for the week'
			});
			expect(weeks[1]!.label).toBe('From this block’s plan: 12–14 sets');
			expect(Object.keys(weeks[1]!.targets).sort()).toEqual(
				['back', 'chest', 'hamstrings', 'hips', 'quads', 'shoulders'].sort()
			);
		});
	});

	it("read a maintenance week by M3's maintenance band for strength, as a dose", async () => {
		await withRollback(async (db) => {
			const { weeks } = await m7Targets(db, M7_SCENARIOS.offSeason());
			expect(weeks).toHaveLength(5);
			for (const week of weeks) {
				expect(week.targets.quads).toEqual([4, 10]);
				expect(week.label).toBe(doseLabel([4, 10]));
				expect(week.label).toBe('Maintenance dose: 4–10 sets');
			}
		});
	});

	it("read a secondary strength goal's weeks by the lower half of its band", async () => {
		await withRollback(async (db) => {
			const { weeks, block } = await m7Targets(db, M7_SCENARIOS.runnerLifter());
			expect(block.weeks.every((w) => w.targets.setsPerGroup === undefined)).toBe(true);
			expect(weeks.map((w) => w.volumeFactor)).toEqual([1, 1, 1, 1.1, 0.6]);
			expect(chestOf(weeks)).toEqual([
				[8, 11],
				[8, 11],
				[8, 11],
				[8.8, 12.1],
				[4.8, 6.6]
			]);
			expect(weeks[0]).toMatchObject({
				label: secondaryLabel([8, 11]),
				band: '8–11, the lower half of the 8–14 that suits getting stronger'
			});
		});
	});

	it('read the split the generator chose from the goals as prepare ranked them', async () => {
		await withRollback(async (db) => {
			// Strength is ranked first, but the marathon is inside its lead window and leads, so the
			// generator held strength as secondary: 8–11, not the 8–14 the profile's order chooses.
			const { weeks, plan } = await m7Targets(db, strengthFirst());
			const led = plan.decisions.find((d) => d.kind === 'priority_resolved')!;
			expect(led.evidence).toMatchObject({ leader: 'Marathon', mode: 'primary' });
			expect(weeks[0]!.targets.back).toEqual([8, 11]);
			expect(weeks[0]!.label).toBe(secondaryLabel([8, 11]));
		});
	});

	it("keep M6's rule for a block a generator before M7 built", async () => {
		await withRollback(async (db) => {
			const { weeks } = await m7Targets(db, strengthFirst(), 'perfo-programming/1');
			expect(weeks[0]).toMatchObject({ label: STORED_TARGET, volumeFactor: 1 });
			expect(weeks[0]!.targets.back).toEqual([8, 14]);
			expect(weeks[3]!.targets.back).toEqual([8.8, 15.4]);
		});
	});

	it("read a fight week by the camp's dose scaled to its volume, as the generator balanced it", async () => {
		await withRollback(async (db) => {
			const { weeks, block } = await m7Targets(db, M7_SCENARIOS.multiGoal());
			const fight = block.weeks.at(-1)!;
			expect(fight.targets).toMatchObject({ volumeFactor: 0.4, setsPerGroup: { min: 4, max: 10 } });
			expect(weeks.at(-1)).toMatchObject({ volumeFactor: 0.4, label: doseLabel([1.6, 4]) });
			expect(weeks.at(-1)!.targets.quads).toEqual([1.6, 4]);
		});
	});

	it('show no target for a fight camp with no strength goal, whatever dose its weeks store', async () => {
		await withRollback(async (db) => {
			const multi = M7_SCENARIOS.multiGoal();
			const fightOnly = { ...multi, goals: multi.goals.filter((g) => g.priority === 1) };
			const { weeks, block } = await m7Targets(db, fightOnly);
			expect(block.weeks.every((w) => w.targets.setsPerGroup !== undefined)).toBe(true);
			for (const week of weeks) {
				expect(week).toMatchObject({ source: 'none', label: NO_STRENGTH_TARGET, targets: {} });
			}
		});
	});

	it.each(['hypertrophyBlock', 'multiGoal', 'offSeason', 'allPaused'] satisfies M7ScenarioKey[])(
		"%s: every week's band is the one the generator wrote in its decisions",
		async (key) => {
			await withRollback(async (db) => {
				const { weeks, block, plan } = await m7Targets(db, M7_SCENARIOS[key]());
				const inFirst = plan.decisions.filter((d) => d.refs.includes('blocks.0'));
				const ramp = inFirst.find((d) => d.kind === 'volume_progressed');
				const dose = inFirst.find(
					(d) =>
						d.kind === 'maintenance_dose' &&
						(d.evidence.stream === 'strength' || d.evidence.stream === 'hypertrophy')
				);
				expect(ramp ?? dose, 'a band in the decisions').toBeDefined();
				expect(weeks).toHaveLength(block.weeks.length);
				const building: number[] = [];
				// As balancePhased balances them: a full week to its own range, any other week to the
				// block's first range (or the dose without one) scaled by its volume factor.
				const full = (w: (typeof block.weeks)[number]) => w.targets.volumeFactor >= 1;
				const first = block.weeks.find((w) => w.targets.setsPerGroup && full(w));
				for (const [i, week] of block.weeks.entries()) {
					const own = week.targets.setsPerGroup;
					const read = weeks[i]!.targets;
					const scale = own && full(week) ? 1 : week.targets.volumeFactor;
					expect(weeks[i]!.volumeFactor).toBe(scale);
					const base = own && full(week) ? own : (first?.targets.setsPerGroup ?? null);
					const [lo, hi] = base ? [base.min, base.max] : doseSets(dose!);
					expect(read.chest![0]).toBeCloseTo(lo! * scale, 2);
					expect(read.chest![1]).toBeCloseTo(hi! * scale, 2);
					if (ramp && !['deload', 'taper', 'event', 'recovery'].includes(week.kind))
						building.push(read.chest![0]);
				}
				if (ramp) expect(building.join(', ')).toBe(ramp.evidence.ramp);
			});
		}
	);
});
