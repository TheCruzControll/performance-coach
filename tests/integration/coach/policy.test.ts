/**
 * The output policy (src/lib/server/agent/policy.ts) through whole coach turns on real Postgres,
 * driven by the mock coach's safety scripts. Each adversarial script streams in 1-, 7- and 64-byte
 * chunks, and its events are decoded back from SSE in chunks of the same size:
 * - a banned phrase that starts after the hold cap (run-on), or across it (straddle), never
 *   reaches the wire or a stored row, and what was released ends at a clause boundary
 * - a context phrase whose pain context comes later in the block (late-context) is never sent
 * - 'drive through the sticking point' without pain passes unchanged
 * - a pain turn never pushes through or diagnoses, and always offers stopping, a gentler option
 *   and a professional, with this turn's alternatives or the generic one
 * - facts citing records the turn did not read, or numbers the cited results do not hold, become
 *   unchecked notes; grounded ones pass
 * - a clean answer streams before the model has finished; every change is a '_policy' row
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';
import { createSseDecoder, encodeSse, type CoachEvent } from '../../../src/lib/domain/coach/events';
import type { RichNode } from '../../../src/lib/domain/coach/rich';
import { GENERIC_GENTLER, scanAdvice, scanForm } from '../../../src/lib/domain/coach/safety';
import { clauseBoundaries } from '../../../src/lib/domain/coach/sentences';
import { SAFETY_REMOVED, UNCHECKED } from '../../../src/lib/server/agent/policy';
import { CONTRACT_CLAUSES } from '../../../src/lib/server/agent/prompt/system';
import {
	LATE_CONTEXT,
	RUN_ON,
	safetyScripts,
	STRADDLE
} from '../../../src/lib/server/agent/provider/mock-scripts/safety';
import { MockProvider, type MockScript } from '../../../src/lib/server/agent/provider/mock';
import type { LlmProvider, ModelRequest } from '../../../src/lib/server/agent/provider/types';
import { defineTool, type CoachTool } from '../../../src/lib/server/agent/tools/define';
import { sourceRefSchema } from '../../../src/lib/server/agent/tools/output';
import { agentToolCalls, type Executor } from '../../../src/lib/server/db';
import type { ResolvedCoachDeps } from '../../../src/lib/server/services/coach/shared';
import { withRollback } from '../helpers';
import { makeOwner } from '../profile/fixtures';
import { recording, runScripted, segmentIssues, storedRows } from './harness';

const CHUNKS = [1, 7, 64] as const;
const PHRASE = 'push through the pain';
const ready = (provider: LlmProvider) => ({ status: 'ready' as const, provider });

type Tool = CoachTool<ResolvedCoachDeps>;

const alternativesTool = defineTool({
	name: 'get_exercise_alternatives',
	description: 'Gentler alternatives, for the policy test.',
	input: z.object({ exercise: z.string() }),
	output: z.object({ items: z.array(z.object({ id: z.string(), name: z.string() })) }),
	run: async () => ({
		items: [
			{ id: 'goblet-squat', name: 'Goblet squat' },
			{ id: 'box-squat', name: 'Box squat' }
		]
	})
}) as Tool;

const historyTool = defineTool({
	name: 'get_exercise_history',
	description: 'One sourced set, for the policy test.',
	input: z.object({}),
	output: z.object({
		best: z.object({ value: z.number(), unit: z.string(), sources: z.array(sourceRefSchema) })
	}),
	run: async () => ({
		best: { value: 102.5, unit: 'kg', sources: [{ type: 'set' as const, id: 'set-1' }] }
	})
}) as Tool;

/** The scripts at `chunk` characters a delta, with `name` forced unless `match` is set. */
function provider(chunk: number, name?: string, extra: MockScript[] = []) {
	const scripts = [...extra, ...safetyScripts].map((script) => ({
		...script,
		steps: script.steps.map((step) => ({ ...step, chunkChars: chunk }))
	}));
	return recording(new MockProvider(scripts, { overrides: () => (name ? { script: name } : {}) }));
}

async function play(
	db: Executor,
	options: { chunk: number; name?: string; text: string; tools?: Tool[]; extra?: MockScript[] }
) {
	const owner = await makeOwner(db);
	const mock = provider(options.chunk, options.name, options.extra);
	const turn = await runScripted(safetyScripts[0]!, {
		db,
		owner,
		text: options.text,
		provider: ready(mock),
		...(options.tools && { tools: options.tools })
	});
	expect(turn.done.status).toBe('completed');
	return { owner, mock, turn, wire: wire(turn.events, options.chunk) };
}

/** The events as the browser decodes them from SSE read `chunk` bytes at a time. */
function wire(events: readonly CoachEvent[], chunk: number) {
	const sse = events.map((event, id) => encodeSse(event, id)).join('');
	const bytes = new TextEncoder().encode(sse);
	const decoder = createSseDecoder();
	const decoded: CoachEvent[] = [];
	for (let at = 0; at < bytes.length; at += chunk)
		decoded.push(...decoder.push(bytes.slice(at, at + chunk)));
	decoded.push(...decoder.end());
	expect(decoded).toEqual(events);
	const deltas = (block: number) =>
		decoded
			.flatMap((event) => (event.type === 'text_delta' && event.block === block ? event.text : []))
			.join('');
	const settled = decoded.filter(
		(event) => event.type === 'block_completed' || event.type === 'block_replaced'
	);
	return { sse, decoded, deltas, settled };
}

function words(nodes: readonly RichNode[]): string {
	return nodes
		.map((node) => {
			if (node.type === 'text' || node.type === 'code') return node.text;
			if (node.type === 'ref') return node.label;
			return words(node.children as RichNode[]);
		})
		.join(' ');
}

/** What the owner ends up reading: every settled block's words. */
const finalText = (settled: readonly CoachEvent[]) =>
	settled.map((event) => ('ast' in event ? words(event.ast) : '')).join('\n');

const holds = (text: string, phrase: string) =>
	scanForm(text).toLowerCase().includes(phrase.toLowerCase());

/** The painMode the turn context message told the model. */
function painModeOf(request: ModelRequest): boolean {
	const context = request.messages.find((message) => (message.role as string) === 'system')!;
	const text = context.content as string;
	return (JSON.parse(text.slice(text.indexOf('\n') + 1)) as { painMode: boolean }).painMode;
}

async function policyRows(db: Executor, runId: string) {
	const rows = await db.select().from(agentToolCalls).where(eq(agentToolCalls.runId, runId));
	return rows.filter((row) => row.name === '_policy');
}

describe('the output policy', () => {
	it('places the adversarial phrases where the scripts say', () => {
		expect(RUN_ON).toHaveLength(300);
		expect(RUN_ON.indexOf(PHRASE)).toBe(260);
		const at = STRADDLE.indexOf(PHRASE);
		expect(at).toBeLessThan(240);
		expect(at + PHRASE.length).toBeGreaterThan(240);
	});

	for (const chunk of CHUNKS)
		for (const [name, text] of [
			['run-on', RUN_ON],
			['straddle', STRADDLE]
		] as const)
			it(`never sends or stores '${PHRASE}' from ${name} in ${chunk}-byte chunks`, async () => {
				await withRollback(async (db) => {
					const { owner, mock, turn, wire } = await play(db, {
						chunk,
						name,
						text: 'How did my last session go?'
					});
					expect(painModeOf(mock.requests[0]!)).toBe(false);

					expect(holds(wire.sse, PHRASE)).toBe(false);
					expect(holds(wire.sse, 'push through')).toBe(false);
					const rows = await storedRows(db, turn.threadId!);
					expect(holds(JSON.stringify(rows), PHRASE)).toBe(false);
					expect(holds(JSON.stringify(await policyRows(db, turn.runId!)), PHRASE)).toBe(false);

					// What was released before the block was replaced ends at a clause boundary.
					const released = wire.deltas(0);
					if (name === 'run-on' || chunk < 64) expect(released).not.toBe('');
					// The phrase is never in what was released, whole or begun.
					if (released !== '') expect(clauseBoundaries(text)).toContain(released.length);
					expect(text.startsWith(released)).toBe(true);
					expect(released).not.toContain('push');
					expect(wire.settled).toMatchObject([
						{ type: 'block_replaced', block: 0, reason: 'safety', kind: 'safety' }
					]);
					expect(await segmentIssues(db, owner, turn.threadId!)).toEqual([]);
				});
			});

	for (const chunk of CHUNKS)
		it(`sends no part of 'keep going' before replacing late-context in ${chunk}-byte chunks`, async () => {
			await withRollback(async (db) => {
				const { turn, wire } = await play(db, {
					chunk,
					name: 'late-context',
					text: 'Should I keep the plan?'
				});
				const released = wire.deltas(0);
				expect('Good work this week.'.startsWith(released)).toBe(true);
				expect(LATE_CONTEXT.startsWith(released)).toBe(true);
				const replaced = wire.decoded.findIndex((event) => event.type === 'block_replaced');
				expect(replaced).toBeGreaterThan(0);
				for (const event of wire.decoded.slice(0, replaced))
					if (event.type === 'text_delta') expect(event.text).not.toMatch(/keep|going|hurts/i);
				expect(holds(wire.sse, 'keep going')).toBe(false);

				const answer = (await storedRows(db, turn.threadId!)).at(-1)!;
				const display = answer.display as { blocks: { kind: string; ast: RichNode[] }[] };
				expect(display.blocks.map((block) => block.kind)).toEqual(['safety']);
				expect(words(display.blocks[0]!.ast)).toContain('Stop the movement');
				expect(holds(JSON.stringify(answer), 'keep going')).toBe(false);
				expect(holds(JSON.stringify(answer), 'even though your knee')).toBe(false);
			});
		});

	it("streams and stores 'drive through the sticking point' unchanged without pain", async () => {
		await withRollback(async (db) => {
			const text =
				'[recommendation] Drive through the sticking point on your top bench set. Your bar speed says the load is right.';
			const script: MockScript = { name: 'sticking', matches: () => true, steps: [{ text }] };
			const { turn, wire } = await play(db, {
				chunk: 7,
				text: 'Any bench cues?',
				extra: [script]
			});
			const body = text.slice('[recommendation] '.length);
			expect(wire.deltas(0)).toBe(body);
			expect(wire.settled).toMatchObject([{ type: 'block_completed', kind: 'recommendation' }]);
			expect(finalText(wire.settled)).toContain('Drive through the sticking point');
			const answer = (await storedRows(db, turn.threadId!)).at(-1)!;
			expect(answer.content).toEqual([{ type: 'text', text, citations: null }]);
			expect(await policyRows(db, turn.runId!)).toEqual([]);
		});
	});

	for (const chunk of CHUNKS)
		it(`answers pain-unsafe with stopping, an alternative and a professional in ${chunk}-byte chunks`, async () => {
			await withRollback(async (db) => {
				const { mock, turn, wire } = await play(db, {
					chunk,
					name: 'pain-unsafe',
					text: 'My knee hurts when I squat.',
					tools: [alternativesTool]
				});
				const shown = finalText(wire.settled);
				expect(scanAdvice(shown, { painContext: true })).toEqual([]);
				expect(shown).toContain('Stop the movement');
				expect(shown).toMatch(/Goblet squat/);
				expect(shown).toMatch(/doctor or physiotherapist/);
				for (const said of ['push through', 'keep going', 'meniscus', 'tendinitis', 'tear'])
					expect(holds(wire.sse, said), said).toBe(false);
				const rows = JSON.stringify(await storedRows(db, turn.threadId!));
				for (const said of ['push through', 'keep going', 'meniscus', 'tendinitis'])
					expect(holds(rows, said), said).toBe(false);
				expect(wire.settled).toMatchObject([
					{ type: 'block_replaced', reason: 'safety', kind: 'safety' },
					{ type: 'block_replaced', reason: 'safety', kind: 'note' }
				]);
				expect(words((wire.settled[1] as { ast: RichNode[] }).ast)).toBe(SAFETY_REMOVED);

				// The contract the model was given, and the turn's pain mode.
				const request = mock.requests[0]!;
				expect(JSON.stringify(request.system)).toContain(
					JSON.stringify(CONTRACT_CLAUSES.pain).slice(1, -1)
				);
				expect(painModeOf(request)).toBe(true);

				const policed = await policyRows(db, turn.runId!);
				expect(policed.map((row) => [row.status, row.input, row.output])).toEqual([
					[
						'intervened',
						{ block: 0, reason: 'safety' },
						{ action: 'replaced', patterns: expect.arrayContaining(['keep_going']) }
					],
					[
						'intervened',
						{ block: 1, reason: 'safety' },
						{ action: 'removed', patterns: expect.arrayContaining(['through_pain']) }
					]
				]);
				for (const said of ['meniscus', 'last two sets', 'knee'])
					expect(JSON.stringify(policed)).not.toContain(said);
			});
		});

	for (const chunk of CHUNKS)
		it(`never sends or stores '${PHRASE}' as a metric's method in ${chunk}-byte chunks`, async () => {
			await withRollback(async (db) => {
				const script: MockScript = {
					name: 'method',
					matches: () => true,
					steps: [
						{ tools: [{ name: 'get_exercise_history', input: {} }] },
						{ text: `[metric method=${PHRASE}] 102.5 kg [[set:set-1|your set]].` }
					]
				};
				const { turn, wire } = await play(db, {
					chunk,
					text: 'My knee hurts when I squat.',
					tools: [historyTool],
					extra: [script]
				});
				expect(holds(wire.sse, PHRASE)).toBe(false);
				expect(holds(JSON.stringify(await storedRows(db, turn.threadId!)), PHRASE)).toBe(false);
				expect(wire.settled[0]).toMatchObject({ type: 'block_replaced', reason: 'safety' });
			});
		});

	it('records a safety replacement when the turn then fails', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const script: MockScript = {
				name: 'fails',
				matches: () => true,
				steps: [
					{
						text: `[recommendation] Just ${PHRASE} today. [note] Then rest`,
						fault: { kind: 'overloaded' }
					}
				]
			};
			const turn = await runScripted(script, { db, owner, text: 'My knee hurts when I squat.' });
			expect(turn.done.status).toBe('failed');
			expect(turn.events).toContainEqual(
				expect.objectContaining({ type: 'block_replaced', block: 0, reason: 'safety' })
			);
			const policed = await policyRows(db, turn.runId!);
			expect(policed.map((row) => row.input)).toContainEqual({ block: 0, reason: 'safety' });
		});
	});

	it('appends the generic gentler option when no alternatives were read', async () => {
		await withRollback(async (db) => {
			const { turn, wire } = await play(db, {
				chunk: 7,
				text: 'My shoulder hurts when I press overhead.'
			});
			expect(wire.settled.map((event) => [event.type, 'kind' in event && event.kind])).toEqual([
				['block_completed', 'note'],
				['block_completed', 'recommendation'],
				['block_completed', 'safety']
			]);
			const guidance = finalText(wire.settled.slice(-1));
			expect(guidance).toContain(GENERIC_GENTLER);
			expect(guidance).toContain('Gentler on');
			expect(guidance).toMatch(/doctor or physiotherapist/);
			expect(scanAdvice(finalText(wire.settled), { painContext: true })).toEqual([]);
			const policed = await policyRows(db, turn.runId!);
			expect(policed.map((row) => [row.input, row.output])).toEqual([
				[
					{ block: 2, reason: 'safety' },
					{ action: 'appended', alternatives: 0 }
				]
			]);
			const answer = (await storedRows(db, turn.threadId!)).at(-1)!;
			expect(JSON.stringify(answer.content)).toContain(GENERIC_GENTLER);
		});
	});

	it('turns ungrounded ids and numbers into unchecked notes, and passes grounded facts', async () => {
		await withRollback(async (db) => {
			const { owner, turn, wire } = await play(db, {
				chunk: 7,
				name: 'ungrounded',
				text: 'What have I lifted?',
				tools: [historyTool]
			});
			const [lead, grounded, number, record] = wire.settled as (CoachEvent & {
				ast: RichNode[];
			})[];
			expect(lead).toMatchObject({ type: 'block_completed', kind: 'note' });
			expect(grounded).toMatchObject({
				type: 'block_completed',
				kind: 'fact',
				grounded: true,
				sources: [{ type: 'set', id: 'set-1', label: 'that set' }]
			});
			for (const block of [number!, record!]) {
				expect(block).toMatchObject({
					type: 'block_replaced',
					reason: 'ungrounded',
					kind: 'note',
					grounded: false,
					sources: []
				});
				expect(words(block.ast.slice(0, 1))).toBe(UNCHECKED);
				expect(JSON.stringify(block.ast)).not.toContain('"ref"');
			}
			expect(words(number!.ast)).toContain('122.5 kg');
			expect(words(record!.ast)).toContain('140 kg');

			const policed = await policyRows(db, turn.runId!);
			expect(policed.map((row) => [row.input, row.output])).toEqual([
				[
					{ block: 2, reason: 'ungrounded' },
					{ uncited: false, unknownRefs: 0, unmatchedNumbers: 1 }
				],
				[
					{ block: 3, reason: 'ungrounded' },
					{ uncited: false, unknownRefs: 1, unmatchedNumbers: 1 }
				]
			]);
			const answer = (await storedRows(db, turn.threadId!)).at(-1)!;
			expect(JSON.stringify(answer.content)).not.toContain('w-invented');
			expect(await segmentIssues(db, owner, turn.threadId!)).toEqual([]);
		});
	});

	it('streams a clean answer before the model has finished it', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const text = '[note] Your week is on track. Two sessions are left. Both are easy runs.';
			const script: MockScript = {
				name: 'clean',
				matches: () => true,
				steps: [{ text, chunkChars: 4, delayMs: 15 }]
			};
			const mock = new MockProvider([script], { overrides: () => ({}) });
			let finished = false;
			const watched: LlmProvider = {
				name: mock.name,
				model: mock.model,
				stream: (request, signal) => {
					const stream = mock.stream(request, signal);
					return {
						async *[Symbol.asyncIterator]() {
							for await (const event of stream) yield event;
							finished = true;
						},
						final: () => stream.final()
					};
				},
				structured: (request, schema, signal) => mock.structured(request, schema, signal),
				countTokens: (request, signal) => mock.countTokens(request, signal)
			};
			const firstDelta: { text: string; finished: boolean }[] = [];
			const turn = await runScripted(script, {
				db,
				owner,
				text: 'How is my week?',
				provider: ready(watched),
				onEvent: (event) => {
					if (event.type === 'text_delta') firstDelta.push({ text: event.text, finished });
				}
			});
			expect(turn.done.status).toBe('completed');
			expect(firstDelta[0]).toEqual({ text: 'Your week is on track.', finished: false });
			expect(firstDelta.map((delta) => delta.text).join('')).toBe(text.slice('[note] '.length));
			expect(await policyRows(db, turn.runId!)).toEqual([]);
		});
	});
});
