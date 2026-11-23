/**
 * The coach writes a weight the owner states (the weight plan's PR 8), on real Postgres:
 * log_body_weight records it at once through the weight service, with source 'coach' and the turn's
 * run, and every refusal writes nothing.
 * - "I weighed 82.4 this morning" records 82.4 kg for today, with source coach and run_id, and the
 *   answer gives the entry, the replaced entry (null on an empty day) and the Undo handle
 * - a weight with no unit takes the profile's unit, and "yesterday" is the day before
 * - NOT_STATED (not said this turn, a question, a hypothetical, someone else's, a number the owner
 *   did not say), CONTRADICTS_OWNER (another unit) and BAD_DATE (a future day, or not the day named)
 *   each write nothing
 * - a replace keeps the earlier entry, so Undo with the run puts it back
 */
import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';
import type { CoachTool } from '../../../src/lib/server/agent/tools/define';
import { toolContext } from '../../../src/lib/server/agent/tools/context';
import { executeToolCalls } from '../../../src/lib/server/agent/tools/execute';
import { WEIGHT_TOOLS } from '../../../src/lib/server/agent/tools/weight';
import { createWeightRepository, type Executor } from '../../../src/lib/server/db';
import { toolRuntime, type ResolvedCoachDeps } from '../../../src/lib/server/services/coach/shared';
import { logWeight, undoCoachWeight } from '../../../src/lib/server/services/weight';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';
import { TURN_NOW } from './harness';

const TODAY = '2026-11-11';
const YESTERDAY = '2026-11-10';
const TOMORROW = '2026-11-12';
const NOW = () => new Date(TURN_NOW);
const TOOL = WEIGHT_TOOLS.find(
	(tool) => tool.name === 'log_body_weight'
)! as CoachTool<ResolvedCoachDeps>;
const TOOLS = [TOOL] as readonly CoachTool<ResolvedCoachDeps>[];

interface Logged {
	weight: number;
	unit: 'kg' | 'lb';
	measuredOn: string;
}

interface Recorded {
	outcome: 'recorded';
	entry: { ref: { type: string; id: string }; measuredOn: string; value: number; unit: string };
	replaced: { value: number; unit: string; source: string } | null;
	undo: { entryId: number; runId: string };
}

/** One call of log_body_weight, as a turn runs it, for `text` the owner's message this turn. */
async function log(db: Executor, owner: string, text: string, input: Logged) {
	const runId = crypto.randomUUID();
	const ctx = toolContext({
		session: { ownerId: owner },
		message: { threadId: crypto.randomUUID(), runId, text, entry: null },
		day: { today: TODAY, timeZone: 'UTC' },
		runtime: toolRuntime({ db, now: NOW }),
		signal: new AbortController().signal,
		deadlineAt: Date.now() + 60_000,
		matchExercise: () => null
	});
	const { outcomes } = await executeToolCalls(
		[{ id: 'toolu_01Weigh', name: 'log_body_weight', input }],
		ctx,
		{ tools: TOOLS }
	);
	const [outcome] = outcomes;
	return { runId, error: outcome!.error, output: outcome!.output as Recorded | undefined };
}

/** Every weigh-in the owner has, as the repository holds them. */
const weighIns = (db: Executor, owner: string) =>
	createWeightRepository(db).listRange(owner, null, TOMORROW);

describe('the coach records a weight the owner states', () => {
	it('records “I weighed 82.4 this morning” at once, with source coach and the turn’s run', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { runId, error, output } = await log(db, owner, 'I weighed 82.4 this morning', {
				weight: 82.4,
				unit: 'kg',
				measuredOn: TODAY
			});
			expect(error).toBeNull();
			expect(z.safeParse(TOOL.outputSchema, output).success).toBe(true);
			expect(output).toEqual({
				outcome: 'recorded',
				entry: { ref: { type: 'weight', id: TODAY }, measuredOn: TODAY, value: 82.4, unit: 'kg' },
				replaced: null,
				undo: { entryId: expect.any(Number), runId }
			});

			const rows = await weighIns(db, owner);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				measuredOn: TODAY,
				value: 82.4,
				unit: 'kg',
				source: 'coach',
				runId,
				replaced: null
			});
		});
	});

	it('takes a weight with no unit in the profile’s unit, and records yesterday when the owner named it', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const plain = await log(db, owner, 'I weighed 82.4 this morning', {
				weight: 82.4,
				unit: 'kg',
				measuredOn: TODAY
			});
			expect(plain.error).toBeNull();
			const past = await log(db, owner, 'yesterday I was 180 lb', {
				weight: 180,
				unit: 'lb',
				measuredOn: YESTERDAY
			});
			expect(past.error).toBeNull();
			expect(past.output).toMatchObject({
				entry: { measuredOn: YESTERDAY, value: 180, unit: 'lb' }
			});
			const rows = (await weighIns(db, owner)).sort((a, b) =>
				a.measuredOn.localeCompare(b.measuredOn)
			);
			expect(rows.map((r) => [r.measuredOn, r.unit, r.source])).toEqual([
				[YESTERDAY, 'lb', 'coach'],
				[TODAY, 'kg', 'coach']
			]);
		});
	});

	const refusals: [string, string, Logged, string][] = [
		[
			'a weight the owner did not say',
			'I feel strong today',
			{ weight: 82.4, unit: 'kg', measuredOn: TODAY },
			'NOT_STATED'
		],
		[
			'a number other than the one stated',
			'I weighed 82.4 this morning',
			{ weight: 83, unit: 'kg', measuredOn: TODAY },
			'NOT_STATED'
		],
		['a question', 'is 82.4 good?', { weight: 82.4, unit: 'kg', measuredOn: TODAY }, 'NOT_STATED'],
		[
			'a hypothetical',
			'if I were 80, I would feel great',
			{ weight: 80, unit: 'kg', measuredOn: TODAY },
			'NOT_STATED'
		],
		[
			'someone else’s weight',
			'my partner weighs 60',
			{ weight: 60, unit: 'kg', measuredOn: TODAY },
			'NOT_STATED'
		],
		[
			'another unit than the owner’s',
			'I weighed 82.4 kg this morning',
			{ weight: 82.4, unit: 'lb', measuredOn: TODAY },
			'CONTRADICTS_OWNER'
		],
		[
			'a unit the owner did not give',
			'I weighed 180 lb this morning',
			{ weight: 180, unit: 'kg', measuredOn: TODAY },
			'CONTRADICTS_OWNER'
		],
		[
			'a future day',
			'I weighed 82.4 this morning',
			{ weight: 82.4, unit: 'kg', measuredOn: TOMORROW },
			'BAD_DATE'
		],
		[
			'a day other than the one named',
			'yesterday I was 82.4 kg',
			{ weight: 82.4, unit: 'kg', measuredOn: TODAY },
			'BAD_DATE'
		]
	];

	it.each(refusals)('refuses %s, and writes nothing', async (_name, text, input, code) => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { error } = await log(db, owner, text, input);
			expect(error?.code).toBe(code);
			expect(await weighIns(db, owner)).toEqual([]);
		});
	});

	it('a replace keeps the earlier entry, so Undo with the run puts it back', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await logWeight(
				owner,
				{ value: 81, unit: 'kg', measuredOn: TODAY },
				{ db, now: NOW, source: 'log' }
			);
			const { runId, error, output } = await log(db, owner, 'I weighed 82.4 this morning', {
				weight: 82.4,
				unit: 'kg',
				measuredOn: TODAY
			});
			expect(error).toBeNull();
			expect(output).toMatchObject({
				replaced: { value: 81, unit: 'kg', source: 'log' },
				undo: { runId }
			});

			const [replacing] = await weighIns(db, owner);
			expect(replacing).toMatchObject({ value: 82.4, source: 'coach', runId });
			expect(replacing!.replaced).toEqual({ value: 81, unit: 'kg', source: 'log' });

			await undoCoachWeight(owner, output!.undo.entryId, runId, { db, now: NOW });
			const [restored] = await weighIns(db, owner);
			expect(restored).toMatchObject({
				value: 81,
				unit: 'kg',
				source: 'log',
				runId: null,
				replaced: null
			});
		});
	});
});
