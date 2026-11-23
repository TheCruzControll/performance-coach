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
 * - a replace keeps the earlier entry, so Undo with the run puts it back, and a second write in
 *   the same run still names that earlier entry as replaced
 * - the Undo card: the turn's event names the weigh-in and its day; the card is listed on reload
 *   only while the weigh-in holds the run's write; Undo after an edit is changed (409), a second
 *   Undo of a fresh weigh-in is gone (404), and after a replace it is changed (409)
 */
import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';
import type { CoachTool } from '../../../src/lib/server/agent/tools/define';
import { toolContext } from '../../../src/lib/server/agent/tools/context';
import { executeToolCalls } from '../../../src/lib/server/agent/tools/execute';
import { WEIGHT_TOOLS } from '../../../src/lib/server/agent/tools/weight';
import { recordedOf } from '../../../src/lib/server/agent/turn';
import { createWeightRepository, type Executor } from '../../../src/lib/server/db';
import { toolRuntime, type ResolvedCoachDeps } from '../../../src/lib/server/services/coach/shared';
import {
	editWeight,
	listThreadWeightLogs,
	logWeight,
	undoCoachWeight,
	WeightUndoError
} from '../../../src/lib/server/services/weight';
import { withRollback } from '../helpers';
import { makeOwner, makeSecondOwner } from '../profile/fixtures';
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

/**
 * One call of log_body_weight, as a turn runs it, for `text` the owner's message this turn. A
 * turn's calls share its run, so a test that makes two calls passes the same `runId` to both.
 */
async function log(
	db: Executor,
	owner: string,
	text: string,
	input: Logged,
	runId = crypto.randomUUID()
) {
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
	return {
		runId,
		outcome: outcome!,
		error: outcome!.error,
		output: outcome!.output as Recorded | undefined
	};
}

/** The reason an Undo was refused, or null when it took the write back. */
const undoRefusal = (undo: Promise<unknown>) =>
	undo.then(
		() => null,
		(err: unknown) => (err instanceof WeightUndoError ? err.reason : err)
	);

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
		],
		[
			'yesterday, for a weight the owner gave with no day',
			'I weighed 82.4 kg',
			{ weight: 82.4, unit: 'kg', measuredOn: YESTERDAY },
			'BAD_DATE'
		],
		[
			'a weight from a year ago',
			'I was 85 last year',
			{ weight: 85, unit: 'kg', measuredOn: TODAY },
			'NOT_STATED'
		],
		[
			'a weight from last week',
			'I weighed 82.4 last week',
			{ weight: 82.4, unit: 'kg', measuredOn: TODAY },
			'NOT_STATED'
		],
		[
			"an owner's age, not a weight",
			"I'm 30",
			{ weight: 30, unit: 'kg', measuredOn: TODAY },
			'NOT_STATED'
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

	it('two writes in one run on a day: replaced names the owner’s entry, and Undo restores it', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await logWeight(
				owner,
				{ value: 81, unit: 'kg', measuredOn: TODAY },
				{ db, now: NOW, source: 'log' }
			);
			const runId = crypto.randomUUID();
			const first = await log(
				db,
				owner,
				'I weighed 82.4 this morning',
				{ weight: 82.4, unit: 'kg', measuredOn: TODAY },
				runId
			);
			const second = await log(
				db,
				owner,
				'I weighed 82 this morning',
				{ weight: 82, unit: 'kg', measuredOn: TODAY },
				runId
			);
			expect(first.error).toBeNull();
			expect(second.error).toBeNull();
			expect(first.output).toMatchObject({ replaced: { value: 81, unit: 'kg', source: 'log' } });
			// The second write replaced the coach's own 82.4, but Undo goes back past the whole run to
			// the owner's 81, so that is what `replaced` names.
			expect(second.output).toMatchObject({
				entry: { value: 82 },
				replaced: { value: 81, unit: 'kg', source: 'log' },
				undo: { entryId: first.output!.undo.entryId, runId }
			});

			const [replacing] = await weighIns(db, owner);
			expect(replacing).toMatchObject({ value: 82, source: 'coach', runId });
			expect(replacing!.replaced).toEqual({ value: 81, unit: 'kg', source: 'log' });

			await undoCoachWeight(owner, second.output!.undo.entryId, runId, { db, now: NOW });
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

describe('the Undo card of a weigh-in the coach logged', () => {
	it('the turn’s event names the weigh-in and words its day from the owner’s today', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { outcome, output } = await log(db, owner, 'I weighed 82.4 this morning', {
				weight: 82.4,
				unit: 'kg',
				measuredOn: TODAY
			});
			expect(recordedOf(outcome, TODAY)).toEqual({
				type: 'recorded',
				kind: 'body_weight',
				id: output!.undo.entryId,
				label: 'Logged 82.4 kg for today'
			});
			// Read the next day, the same weigh-in is yesterday; two days on, its weekday.
			expect(recordedOf(outcome, TOMORROW)).toMatchObject({
				label: 'Logged 82.4 kg for yesterday'
			});
			expect(recordedOf(outcome, '2026-11-13')).toMatchObject({
				label: 'Logged 82.4 kg for Wed 11 Nov'
			});
		});
	});

	it('names no card for a refused write', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { outcome } = await log(db, owner, 'I feel strong today', {
				weight: 82.4,
				unit: 'kg',
				measuredOn: TODAY
			});
			expect(recordedOf(outcome, TODAY)).toBeNull();
		});
	});

	it('is listed on reload while its weigh-in holds the run’s write, and not after Undo', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { runId, output } = await log(db, owner, 'I weighed 82.4 this morning', {
				weight: 82.4,
				unit: 'kg',
				measuredOn: TODAY
			});
			const entryId = output!.undo.entryId;
			expect(await listThreadWeightLogs(owner, [runId], { db })).toEqual([
				{ id: entryId, runId, measuredOn: TODAY, value: 82.4, unit: 'kg' }
			]);
			// Only the owner’s own weigh-ins, and only runs that are real ids.
			const other = await makeSecondOwner(db);
			expect(await listThreadWeightLogs(other, [runId], { db })).toEqual([]);
			expect(await listThreadWeightLogs(owner, ['not-a-run'], { db })).toEqual([]);

			await undoCoachWeight(owner, entryId, runId, { db, now: NOW });
			expect(await listThreadWeightLogs(owner, [runId], { db })).toEqual([]);
		});
	});

	it('an Undo after the owner edited the weigh-in is refused as changed (the 409)', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { runId, output } = await log(db, owner, 'I weighed 82.4 this morning', {
				weight: 82.4,
				unit: 'kg',
				measuredOn: TODAY
			});
			const entryId = output!.undo.entryId;
			await editWeight(
				owner,
				entryId,
				{ value: 83, unit: 'kg', measuredOn: TODAY },
				{ db, now: NOW }
			);
			expect(await undoRefusal(undoCoachWeight(owner, entryId, runId, { db, now: NOW }))).toBe(
				'changed'
			);
			// The owner's edit stands: nothing was taken back.
			expect(await weighIns(db, owner)).toMatchObject([{ value: 83, source: 'log' }]);
		});
	});

	it('a second Undo of a fresh weigh-in is gone (the 404)', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const { runId, output } = await log(db, owner, 'I weighed 82.4 this morning', {
				weight: 82.4,
				unit: 'kg',
				measuredOn: TODAY
			});
			const entryId = output!.undo.entryId;
			expect(
				await undoRefusal(undoCoachWeight(owner, entryId, runId, { db, now: NOW }))
			).toBeNull();
			expect(await weighIns(db, owner)).toEqual([]);
			expect(await undoRefusal(undoCoachWeight(owner, entryId, runId, { db, now: NOW }))).toBe(
				'gone'
			);
		});
	});

	it('a second Undo after a replace is changed (the 409): the earlier entry is back, not the coach’s', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await logWeight(
				owner,
				{ value: 81, unit: 'kg', measuredOn: TODAY },
				{ db, now: NOW, source: 'log' }
			);
			const { runId, output } = await log(db, owner, 'I weighed 82.4 this morning', {
				weight: 82.4,
				unit: 'kg',
				measuredOn: TODAY
			});
			const entryId = output!.undo.entryId;
			expect(
				await undoRefusal(undoCoachWeight(owner, entryId, runId, { db, now: NOW }))
			).toBeNull();
			expect(await weighIns(db, owner)).toMatchObject([{ value: 81, source: 'log', runId: null }]);
			expect(await undoRefusal(undoCoachWeight(owner, entryId, runId, { db, now: NOW }))).toBe(
				'changed'
			);
		});
	});
});
