/**
 * The periodisation road (services/periodisation/road-view.ts, m7/37) on real Postgres, from
 * programs the generator builds for M7's scenario profiles and stored as a build stores them:
 * - an M7-built multiGoal program reads the fight primary, the marathon secondary and build
 *   muscle and keep strength at maintenance, from its decisions, then the marathon's road, its
 *   recovery and a muscle-building block
 * - an M3-built hybrid (M7's prepare left out, so no mode decisions) gives the same shape, its
 *   modes worked out from its goals and labelled so
 * - an allPaused program reads one maintenance block with every goal at maintenance, as does an
 *   off-season's maintenance block, its top-ranked goal included
 * - a pre-M7 half reads 'Half marathon build', never 'Marathon build'
 * - events count weeks from today; a bridge between blocks appears with its length
 * - another owner's program is not found
 * - one versionTree read per call, and the coach's serialised road stays within 1.5 KB
 * Every read runs one query at a time on one client (the setup's busy-client guard).
 */
import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IsoDate } from '../../../src/lib/domain/calendar';
import { CATALOGUE } from '../../../src/lib/domain/exercises/index';
import type { TrainingProfile } from '../../../src/lib/domain/profile/types';
import { generateProgram } from '../../../src/lib/domain/programming/generate';
import { buildProgrammingInput } from '../../../src/lib/domain/programming/input';
import { M7_SCENARIOS, m7Day } from '../../../src/lib/domain/programming/periodisation/scenarios';
import type { DecisionPlan } from '../../../src/lib/domain/training/types';
import { GENERATOR_ID } from '../../../src/lib/domain/programming/random';
import { SCENARIO_START, SCENARIOS } from '../../../src/lib/domain/programming/scenarios';
import * as stages from '../../../src/lib/domain/programming/stages/prepare';
import type { Executor } from '../../../src/lib/server/db';
import {
	DERIVED_MODES_NOTE,
	getRoadView,
	MAINTENANCE_LABEL,
	ROAD_TEXT_MAX_BYTES,
	serialiseRoad,
	type RoadView
} from '../../../src/lib/server/services/periodisation/road-view';
import { createProgramFromPlan } from '../../../src/lib/server/services/programs/index';
import { atLocal } from '../../../src/lib/server/test-support/analytics-fixtures/dashboards';
import { seedAnalyticsFixture } from '../../../src/lib/server/test-support/analytics-fixtures/index';
import { withRollback } from '../helpers';
import { makeOwner, makeSecondOwner } from '../profile/fixtures';

/** Wednesday of week 1: every scenario plan starts on Monday SCENARIO_START. */
const TODAY = '2026-11-11';

afterEach(() => {
	vi.restoreAllMocks();
});

/** `profile`'s plan, built by M7's generator, or by M3's (prepare as the identity: no season). */
function planOf(profile: TrainingProfile, { m3 = false } = {}) {
	if (m3) {
		vi.spyOn(stages, 'prepare').mockImplementation((input) => ({ input, periodisation: null }));
	}
	const input = buildProgrammingInput(profile, { catalogue: CATALOGUE });
	const plan = generateProgram(input, {
		startsOn: SCENARIO_START,
		firstPlannedDay: SCENARIO_START
	});
	vi.restoreAllMocks();
	return { input, plan };
}

/** The plan stored as a build stores it: with its generator and its input snapshot. */
async function seed(
	db: Executor,
	profile: TrainingProfile,
	options: { m3?: boolean; edit?: (d: DecisionPlan) => DecisionPlan } = {}
) {
	const owner = await makeOwner(db);
	const { input, plan } = planOf(profile, options);
	const snapshot = input as unknown as Record<string, unknown>;
	const { edit = (d: DecisionPlan) => d } = options;
	await createProgramFromPlan(
		owner,
		{ ...plan, decisions: plan.decisions.map(edit) },
		{ source: 'rules', generator: GENERATOR_ID, snapshot },
		{ db }
	);
	return owner;
}

async function road(db: Executor, owner: string, today: IsoDate = TODAY): Promise<RoadView> {
	const view = await getRoadView(owner, today, { db });
	if (!view) throw new Error('no road');
	return view;
}

const modes = (view: RoadView, i: number) =>
	view.blocks[i]!.goals.map((g) => `${g.title}: ${g.mode}`);

/** A half marathon in hybrid's marathon place: M3 planned it as marathon_* phases. */
function half(): TrainingProfile {
	const profile = SCENARIOS.hybrid();
	profile.goals = profile.goals.map((g) =>
		g.eventType === 'Marathon' ? { ...g, title: 'Half marathon', eventType: 'Half marathon' } : g
	);
	return profile;
}

describe('getRoadView', () => {
	it('an M7-built multiGoal program: the fight leads, the marathon trains alongside, the rest held', async () => {
		await withRollback(async (db) => {
			const view = await road(db, await seed(db, M7_SCENARIOS.multiGoal()));
			expect(view.blocks.map((b) => b.label)).toEqual([
				'Fight camp',
				'Recovery',
				'Marathon base',
				'Marathon build',
				'Marathon peak',
				'Marathon taper',
				'Recovery',
				'Hypertrophy'
			]);
			expect(modes(view, 0)).toEqual([
				'Muay Thai fight: primary',
				'Marathon: secondary',
				'Build muscle: maintenance',
				'Keep strength: maintenance'
			]);
			expect(view.blocks[0]).toMatchObject({ outline: false, modesNote: null });
			expect(view.blocks[0]!.goals[0]).toMatchObject({
				ref: buildProgrammingInput(M7_SCENARIOS.multiGoal(), { catalogue: CATALOGUE }).refs
					.goals[0],
				discipline: 'muay_thai'
			});
			// The marathon's run-up, decided: the marathon leads once the fight is over.
			expect(view.blocks[2]).toMatchObject({ outline: true, weeks: [], modesNote: null });
			expect(modes(view, 2)[0]).toBe('Marathon: primary');
			// After the marathon: its recovery, then build muscle leads, by its own decision (the
			// rules alone would put the top-ranked fight first).
			expect(modes(view, 7)[0]).toBe('Build muscle: primary');
			expect(view.blocks[7]!.modesNote).toBeNull();
			// Decided, every block: a season window's decision names only its first block.
			expect(view.blocks.map((b) => b.modesNote)).toEqual(Array(8).fill(null));
			expect(modes(view, 3)[0]).toBe('Marathon: primary');
			// Its recoveries hold every goal, the long-past fight included.
			for (const i of [1, 6]) {
				expect(view.blocks[i]!.goals.map((g) => g.mode)).not.toContain('primary');
			}
			// Today is week 1 of the camp; its deload and the taper weeks are marked ahead.
			expect(view.current).toEqual({ block: 0, week: 0 });
			expect(view.blocks[0]!.weeks.map((w) => w.current)).toEqual([
				true,
				...Array<boolean>(9).fill(false)
			]);
			expect(view.markers).toEqual([
				{ week: m7Day(5, 0), kind: 'deload', label: 'Deload week' },
				{ week: m7Day(22, 0), kind: 'taper', label: 'Marathon taper' }
			]);
		});
	});

	it('takes each block’s leader from its decision: by the goal’s ref, or by its title', async () => {
		await withRollback(async (db) => {
			const refs = buildProgrammingInput(M7_SCENARIOS.multiGoal(), { catalogue: CATALOGUE }).refs;
			// Stored decisions never change, so the plan's are edited before it is stored.
			const owner = await seed(db, M7_SCENARIOS.multiGoal(), {
				edit: (decision) =>
					decision.kind !== 'priority_resolved'
						? decision
						: decision.refs.includes('blocks.0')
							? { ...decision, evidence: { ...decision.evidence, goalRef: refs.goals[2]! } }
							: decision.refs.includes('blocks.7')
								? { ...decision, evidence: { ...decision.evidence, leader: 'Keep strength' } }
								: decision
			});
			const view = await road(db, owner);
			expect(modes(view, 0)).toEqual([
				'Build muscle: primary',
				'Muay Thai fight: secondary',
				'Marathon: secondary',
				'Keep strength: maintenance'
			]);
			// Before M7 stored refs, the leader's title names it; the goal the rules alone would
			// put first (the top-ranked fight) trains alongside.
			expect(modes(view, 7)).toEqual([
				'Keep strength: primary',
				'Muay Thai fight: secondary',
				'Marathon: secondary',
				'Build muscle: maintenance'
			]);
		});
	});

	it('an M3-built hybrid: the same shape, its modes worked out from its goals and labelled', async () => {
		await withRollback(async (db) => {
			const view = await road(db, await seed(db, SCENARIOS.hybrid(), { m3: true }));
			expect(view.blocks[0]).toMatchObject({
				label: 'Marathon base',
				modesNote: DERIVED_MODES_NOTE
			});
			expect(modes(view, 0)).toEqual([
				'Marathon: primary',
				'Stay strong: secondary',
				'Muay Thai: maintenance'
			]);
			expect(view.blocks.every((b) => b.modesNote === DERIVED_MODES_NOTE)).toBe(true);
		});
	});

	it('an allPaused program: one maintenance block, every goal at maintenance', async () => {
		await withRollback(async (db) => {
			const view = await road(db, await seed(db, M7_SCENARIOS.allPaused()));
			expect(view.blocks).toHaveLength(1);
			expect(view.blocks[0]).toMatchObject({
				phase: 'maintenance',
				label: MAINTENANCE_LABEL,
				modesNote: null
			});
			expect(modes(view, 0)).toEqual([
				'Keep strength: maintenance',
				'Keep running fitness: maintenance'
			]);
		});
	});

	it('an off-season’s maintenance block holds every goal, the top-ranked one included', async () => {
		await withRollback(async (db) => {
			const view = await road(db, await seed(db, M7_SCENARIOS.offSeason()));
			const held = view.blocks.findIndex((b) => b.phase === 'maintenance');
			expect(view.blocks[held]!.label).toBe(MAINTENANCE_LABEL);
			expect(modes(view, held)).toEqual([
				'Keep strength: maintenance',
				'Keep running fitness: maintenance'
			]);
		});
	});

	it('a pre-M7 half reads Half marathon, never Marathon', async () => {
		await withRollback(async (db) => {
			const view = await road(db, await seed(db, half(), { m3: true }));
			const labels = view.blocks.map((b) => b.label);
			expect(view.blocks.map((b) => b.phase)).toContain('marathon_build');
			expect(labels).toContain('Half marathon build');
			expect(labels.filter((l) => l.startsWith('Marathon'))).toEqual([]);
		});
	});

	it('events count whole weeks from today, soonest first, and only those ahead', async () => {
		await withRollback(async (db) => {
			const owner = await seed(db, M7_SCENARIOS.multiGoal());
			expect((await road(db, owner)).events).toEqual([
				{ goalTitle: 'Muay Thai fight', date: '2027-01-16', weeksAway: 9 },
				{ goalTitle: 'Marathon', date: '2027-04-25', weeksAway: 23 }
			]);
			// After the fight: the camp has ended, so the road starts at its recovery.
			const later = await road(db, owner, '2027-01-20');
			expect(later.events).toEqual([{ goalTitle: 'Marathon', date: '2027-04-25', weeksAway: 13 }]);
			expect(later.blocks[0]!.label).toBe('Recovery');
			expect(later.current).toEqual({ block: 0, week: null });
		});
	});

	it('a bridge between blocks appears as Between blocks, with its length and no goals', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const today = '2026-11-18';
			const now = atLocal(today, '12:00', 'America/Los_Angeles');
			await seedAnalyticsFixture(
				owner,
				'bridge-week',
				{ timeZone: 'America/Los_Angeles', now },
				{ db }
			);
			const view = await road(db, owner, today);
			const bridge = view.blocks.find((b) => b.phase === 'transition')!;
			expect(bridge).toMatchObject({ label: 'Between blocks', goals: [], modesNote: null });
			expect(bridge.weeks.map((w) => w.kind)).toEqual(['unplanned', 'unplanned', 'unplanned']);
			expect(view.current).toEqual({ block: view.blocks.indexOf(bridge), week: 2 });
		});
	});

	it('another owner’s program is not found', async () => {
		await withRollback(async (db) => {
			await seed(db, M7_SCENARIOS.multiGoal());
			const other = await makeSecondOwner(db);
			expect(await getRoadView(other, TODAY, { db })).toBeNull();
		});
	});

	it('reads versionTree once, and serialises within 1.5 KB, even for the longest season', async () => {
		await withRollback(async (db) => {
			const owner = await seed(db, M7_SCENARIOS.longSeason());
			const query = vi.spyOn(pg.Client.prototype, 'query');
			const view = await road(db, owner);
			const sent = query.mock.calls.map(([q]) =>
				typeof q === 'string' ? q : String((q as { text?: string }).text)
			);
			query.mockRestore();
			expect(sent.filter((q) => q.includes('from "program_version_weeks"'))).toHaveLength(1);
			expect(sent).toHaveLength(5);
			const text = serialiseRoad(view);
			expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(ROAD_TEXT_MAX_BYTES);
			expect(text.split('\n')[0]).toBe(
				`Now: ${view.blocks[0]!.label}, week 1 of ${view.blocks[0]!.weeks.length}.`
			);
		});
	});
});
