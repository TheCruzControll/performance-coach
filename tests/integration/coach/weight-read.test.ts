/**
 * The coach's weight read on real Postgres (the weight plan's PR 7): get_body_weight answers with
 * the figures the Weight view and the coach's facts compute (services/weight), in the owner's unit,
 * as metrics and facts with their sources, and a turn over it is grounded:
 * - the trend, latest weigh-in, stale flag, 28-day rate, 30-day stats, log rows and goal (verdict,
 *   gap, rates, percent, milestones and their statuses) equal the services' own figures
 * - a change is an unsigned size with its direction, and a metric has the method it was computed by
 * - an lb owner reads pounds, and the figures are the same weigh-ins converted
 * - no weigh-in reads insufficient_data, never a zero; a goal with no weigh-in around its start
 *   reads no_data
 * - another owner's id reads nothing of the owner's
 * - the tool is a read (not strict, analytics group), and every output validates against its schema
 * - 'Am I losing faster than planned?' calls get_body_weight, and its answer is grounded
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';
import { addDays } from '../../../src/lib/domain/calendar';
import { TURN_LIMITS } from '../../../src/lib/domain/coach/budgets';
import { convertWeight } from '../../../src/lib/domain/units';
import { weightScripts } from '../../../src/lib/server/agent/provider/mock-scripts/weight';
import { toolContext } from '../../../src/lib/server/agent/tools/context';
import type { CoachTool } from '../../../src/lib/server/agent/tools/define';
import { executeToolCalls } from '../../../src/lib/server/agent/tools/execute';
import { capOutput } from '../../../src/lib/server/agent/tools/output';
import { WEIGHT_TOOLS, weightOutputOf } from '../../../src/lib/server/agent/tools/weight';
import { agentToolCalls, createWeightRepository, type Executor } from '../../../src/lib/server/db';
import { toolRuntime, type ResolvedCoachDeps } from '../../../src/lib/server/services/coach/shared';
import { saveBasics } from '../../../src/lib/server/services/profile';
import {
	getWeightFacts,
	getWeightView,
	logWeight,
	type WeightFacts
} from '../../../src/lib/server/services/weight';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';
import { runScripted, TURN_NOW } from './harness';

const TODAY = '2026-11-11';
const NOW = () => new Date(TURN_NOW);
const TOOL = WEIGHT_TOOLS[0]! as CoachTool<ResolvedCoachDeps>;
const TOOLS = [TOOL] as readonly CoachTool<ResolvedCoachDeps>[];

/** Every second weigh-in from 1 September, falling from 88 kg to 82.5 kg. */
const WEIGH_INS: [string, number][] = [
	['2026-09-01', 88],
	['2026-09-08', 87.4],
	['2026-09-15', 86.9],
	['2026-09-22', 86.3],
	['2026-09-29', 85.8],
	['2026-10-06', 85.1],
	['2026-10-13', 84.7],
	['2026-10-20', 84.2],
	['2026-10-27', 83.9],
	['2026-11-03', 83.1],
	['2026-11-07', 82.8],
	['2026-11-10', 82.5]
];

/** The weigh-ins, logged through the service in the owner's unit (to 2 decimals, as a scale reads). */
async function seed(db: Executor, owner: string, unit: 'kg' | 'lb' = 'kg') {
	for (const [measuredOn, value] of WEIGH_INS) {
		const logged = unit === 'kg' ? value : Math.round(convertWeight(value, 'kg', 'lb') * 100) / 100;
		await logWeight(owner, { value: logged, unit, measuredOn }, { db, now: NOW });
	}
}

/** A loss goal from 88 kg on 1 September to 80 kg on 31 December, with three milestones. */
async function goal(db: Executor, owner: string) {
	const repo = createWeightRepository(db);
	const active = await repo.insertGoal({
		ownerId: owner,
		unit: 'kg',
		startOn: '2026-09-01',
		startWeight: 88,
		targetOn: '2026-12-31',
		targetWeight: 80,
		source: 'log',
		createdAt: new Date('2026-09-01T09:00:00Z'),
		updatedAt: new Date('2026-09-01T09:00:00Z')
	});
	await repo.replaceMilestones(
		owner,
		active.id,
		[
			{ onDate: '2026-10-05', weight: 86, source: 'generated' },
			{ onDate: '2026-11-05', weight: 84, source: 'generated' },
			{ onDate: '2026-12-01', weight: 82, source: 'generated' }
		],
		NOW()
	);
	return active.id;
}

/** The tool's output for `ownerId`, run as a turn runs it, checked against its output schema. */
async function readWeight(db: Executor, ownerId: string): Promise<Out> {
	const ctx = toolContext({
		session: { ownerId },
		message: { threadId: crypto.randomUUID(), runId: crypto.randomUUID(), text: '', entry: null },
		day: { today: TODAY, timeZone: 'UTC' },
		runtime: toolRuntime({ db, now: NOW }),
		signal: new AbortController().signal,
		deadlineAt: Date.now() + 60_000,
		matchExercise: () => null
	});
	const { outcomes } = await executeToolCalls(
		[{ id: 'toolu_01Weight', name: 'get_body_weight', input: {} }],
		ctx,
		{ tools: TOOLS }
	);
	const [outcome] = outcomes;
	expect(outcome!.error).toBeNull();
	expect(z.safeParse(TOOL.outputSchema, outcome!.output).success).toBe(true);
	return outcome!.output as Out;
}

interface Ref {
	type: string;
	id: string;
	label?: string;
	date?: string;
}
interface Metric {
	value: number;
	unit: string | null;
	method: string;
	sources: Ref[];
}
interface Movement extends Metric {
	direction: 'up' | 'down' | 'flat';
}
interface Out {
	status: string;
	reason?: string;
	unit: 'kg' | 'lb';
	today: string;
	latest: { day: string; weight: number; source: Ref };
	trend: Metric;
	stale: boolean;
	weeklyRate: Movement | null;
	stats: {
		days: number;
		highest: { day: string; weight: number; source: Ref } | null;
		lowest: { day: string; weight: number; source: Ref } | null;
		change: Movement | null;
	};
	logBook: {
		day: string;
		weight: number;
		trend: number;
		change: { amount: number; direction: string } | null;
		weeklyRate: { amount: number; direction: string } | null;
		source: Ref;
	}[];
	goal: null | {
		startWeight: number;
		verdict: string;
		gap: Metric | null;
		requiredRate: Movement | null;
		actualRate: Movement | null;
		percentDone: Metric | null;
		distanceLeft: Metric | null;
		daysLeft: number | null;
		nextMilestone: { day: string; weight: number } | null;
		stale: boolean | null;
		milestones: { day: string; weight: number; status: string }[];
		source: Ref;
	};
}

/** A change as the tool gives it: its size, never signed, and its direction. */
const movementOf = (change: number) => ({
	value: Math.abs(change),
	direction: change < 0 ? 'down' : change > 0 ? 'up' : 'flat'
});
/** A log row's change as the tool gives it: its amount and direction. */
const step = (change: number) => ({
	amount: Math.abs(change),
	direction: movementOf(change).direction
});

describe('the coach reads the owner’s weight', () => {
	it('gives the trend, rate, stats, log rows and goal the Weight view and the facts compute', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await seed(db, owner);
			const id = await goal(db, owner);
			const facts = await getWeightFacts(owner, TODAY, { db });
			const view = await getWeightView(owner, 'all', TODAY, { db });
			const out = await readWeight(db, owner);

			expect(out.status).toBe('ok');
			expect(out.unit).toBe('kg');
			expect(out.today).toBe(TODAY);
			expect(out.latest.day).toBe('2026-11-10');
			expect(out.latest.weight).toBe(82.5);
			expect(out.trend.value).toBe(facts.trend);
			expect(out.trend.unit).toBe('kg');
			expect(out.stale).toBe(facts.stale);
			expect(out.weeklyRate?.value).toBe(Math.abs(facts.weeklyRate!));
			expect(out.weeklyRate?.direction).toBe(movementOf(facts.weeklyRate!).direction);

			expect(out.stats.days).toBe(30);
			expect(out.stats.highest?.weight).toBe(facts.stats.highest?.weight);
			expect(out.stats.highest?.day).toBe(facts.stats.highest?.day);
			expect(out.stats.lowest?.weight).toBe(facts.stats.lowest?.weight);
			expect(out.stats.lowest?.day).toBe(facts.stats.lowest?.day);
			expect(out.stats.change?.value).toBe(Math.abs(facts.stats.change!));
			expect(out.stats.change?.direction).toBe(movementOf(facts.stats.change!).direction);

			expect(out.logBook.map(({ day, weight, trend }) => ({ day, weight, trend }))).toEqual(
				facts.logBook.map(({ day, weight, trend }) => ({ day, weight, trend }))
			);
			expect(out.logBook).toHaveLength(12);
			expect(out.logBook[0]!.day).toBe('2026-11-10');
			const [newest, ...earlier] = facts.logBook;
			expect(out.logBook[0]!.change).toEqual(step(newest!.change!));
			expect(out.logBook[0]!.weeklyRate).toEqual(step(newest!.weeklyRate!));
			expect(out.logBook[1]!.change).toEqual(step(earlier[0]!.change!));

			const status = view.goal!.status;
			expect(out.goal!.verdict).toBe(status.verdict);
			expect(out.goal!.milestones).toEqual(view.goal!.milestones);
			expect(out.goal!.source).toEqual({ type: 'weight_goal', id, label: 'Weight goal' });
			if (status.verdict === 'no_data') throw new Error('the goal has weigh-ins');
			expect(out.goal!.gap?.value).toBe(status.gap);
			expect(out.goal!.requiredRate).toMatchObject(movementOf(status.requiredRate!));
			expect(out.goal!.actualRate).toMatchObject(movementOf(status.actualRate!));
			expect(out.goal!.percentDone).toMatchObject({ value: status.percentDone, unit: '%' });
			expect(out.goal!.distanceLeft?.value).toBe(status.distanceLeft);
			expect(out.goal!.daysLeft).toBe(status.daysLeft);
			expect(out.goal!.nextMilestone).toEqual(status.nextMilestone);
			expect(out.goal!.stale).toBe(status.stale);
		});
	});

	it('marks each computed figure with its method and the weigh-ins it rests on, and a weigh-in as a fact', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await seed(db, owner);
			const id = await goal(db, owner);
			const out = await readWeight(db, owner);
			const latest = { type: 'weight', id: '2026-11-10' };

			expect(out.latest.source).toEqual(latest);
			expect(out.trend.method).toMatch(/\S/);
			expect(out.trend.sources).toEqual([latest]);
			expect(out.weeklyRate?.sources).toEqual([latest]);
			expect(out.goal!.gap!.sources).toEqual([
				{ type: 'weight_goal', id, label: 'Weight goal' },
				latest
			]);
			const methods = [out.trend, out.weeklyRate, out.stats.change, out.goal!.gap].flatMap((m) =>
				m ? [m.method] : []
			);
			expect(new Set(methods).size).toBe(methods.length);
			// Every change is an unsigned size with a direction: no negative number reaches the model.
			const changes = [
				out.weeklyRate,
				out.stats.change,
				out.goal!.requiredRate,
				out.goal!.actualRate
			];
			for (const change of changes) if (change) expect(change.value).toBeGreaterThanOrEqual(0);
			for (const row of out.logBook) {
				if (row.change) expect(row.change.amount).toBeGreaterThanOrEqual(0);
				if (row.weeklyRate) expect(row.weeklyRate.amount).toBeGreaterThanOrEqual(0);
			}
		});
	});

	it('reads pounds for an owner who logs in pounds, the same weigh-ins converted', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await saveBasics(owner, { name: 'Niko', weightUnit: 'lb', distanceUnit: 'km' }, { db });
			await seed(db, owner, 'lb');
			await goal(db, owner);
			const facts: WeightFacts = await getWeightFacts(owner, TODAY, { db });
			const out = await readWeight(db, owner);

			expect(out.unit).toBe('lb');
			expect(out.trend.unit).toBe('lb');
			expect(out.latest.weight).toBeCloseTo(82.5 / 0.45359237, 1);
			expect(out.trend.value).toBe(facts.trend);
			expect(out.goal!.gap!.unit).toBe('lb');
			expect(out.goal!.startWeight).toBeCloseTo(88 / 0.45359237, 1);
		});
	});

	it('stays under the tool output cap in the worst case: an lb owner, 14 log rows and 24 milestones', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await saveBasics(owner, { name: 'Niko', weightUnit: 'lb', distanceUnit: 'km' }, { db });
			// Twenty-seven daily weigh-ins in pounds, with two decimals each, so no figure is short.
			for (let i = 0; i < 27; i++) {
				const measuredOn = addDays('2026-10-15', i);
				const value = Math.round((190.5 - i * 0.12 + (i % 3) * 0.37) * 100) / 100;
				await logWeight(owner, { value, unit: 'lb', measuredOn }, { db, now: NOW });
			}
			const repo = createWeightRepository(db);
			const active = await repo.insertGoal({
				ownerId: owner,
				unit: 'lb',
				startOn: '2026-09-01',
				startWeight: 200.25,
				targetOn: '2026-12-31',
				targetWeight: 180.75,
				source: 'log',
				createdAt: new Date('2026-09-01T09:00:00Z'),
				updatedAt: new Date('2026-09-01T09:00:00Z')
			});
			// Twenty-four milestones, one every five days from 6 September, all between start and target.
			await repo.replaceMilestones(
				owner,
				active.id,
				Array.from({ length: 24 }, (_, k) => ({
					onDate: addDays('2026-09-06', k * 5),
					weight: Math.round((199.1 - k * 0.7) * 100) / 100,
					source: 'generated' as const
				})),
				NOW()
			);

			const facts = await getWeightFacts(owner, TODAY, { db });
			expect(facts.logBook).toHaveLength(14);
			expect(facts.goal!.milestones).toHaveLength(24);
			const output = weightOutputOf(facts);
			const capped = capOutput(output);
			const bytes = new TextEncoder().encode(capped.json).length;
			expect(bytes).toBeLessThan(TURN_LIMITS.toolOutputBytes);
			expect(capped.truncated).toBe(false);
			expect(z.safeParse(TOOL.outputSchema, capped.value).success).toBe(true);
		});
	});

	it('reads insufficient_data with no weigh-in, never a zero', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			expect(await readWeight(db, owner)).toEqual({
				status: 'insufficient_data',
				reason: 'no_weigh_ins'
			});
		});
	});

	it('reads no_data for a goal with no weigh-in around its start, and still the trend', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await logWeight(owner, { value: 90, unit: 'kg', measuredOn: '2026-01-05' }, { db, now: NOW });
			await goal(db, owner);
			const out = await readWeight(db, owner);
			expect(out.status).toBe('ok');
			expect(out.goal!.verdict).toBe('no_data');
			expect(out.goal!.gap).toBeNull();
			expect(out.goal!.requiredRate).toBeNull();
			expect(out.trend.value).toBe(90);
		});
	});

	it('reads nothing of the owner’s for another owner’s id', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await seed(db, owner);
			await goal(db, owner);
			expect(await readWeight(db, crypto.randomUUID())).toEqual({
				status: 'insufficient_data',
				reason: 'no_weigh_ins'
			});
		});
	});

	it('is a read in the analytics group, not strict, with a stated empty input', () => {
		expect(TOOL.name).toBe('get_body_weight');
		expect(TOOL.entry).toEqual({ group: 'analytics', effect: 'read', drafts: false });
		expect(TOOL.definition.strict).toBe(false);
		expect(TOOL.definition.input_schema).toMatchObject({ type: 'object', properties: {} });
	});

	it('answers “Am I losing faster than planned?” from the tool, and the answer is grounded', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await seed(db, owner);
			await goal(db, owner);
			const turn = await runScripted(weightScripts[0]!, {
				db,
				owner,
				text: 'Am I losing faster than planned?',
				tools: TOOLS
			});
			expect(turn.done.status).toBe('completed');
			const activity = turn.events.flatMap((e) =>
				e.type === 'activity' && e.tool === 'get_body_weight' && e.state === 'done' ? [e.label] : []
			);
			expect(activity).toEqual(['Read your weight trend']);
			expect(turn.events.some((e) => e.type === 'block_replaced')).toBe(false);
			const blocks = turn.events.flatMap((e) => (e.type === 'block_completed' ? [e] : []));
			expect(blocks.length).toBeGreaterThan(0);
			expect(blocks.every((block) => block.grounded)).toBe(true);
			const calls = await db
				.select({ name: agentToolCalls.name, status: agentToolCalls.status })
				.from(agentToolCalls)
				.where(eq(agentToolCalls.runId, turn.runId!));
			expect(calls).toEqual([{ name: 'get_body_weight', status: 'succeeded' }]);
		});
	});
});
