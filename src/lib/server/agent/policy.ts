/**
 * The output gate between the answer parser and the wire (the turn's hook; the M5 plan's pain
 * policy and grounding). No character of an answer reaches the wire before it has been scanned
 * together with everything that could complete a banned pattern (domain/coach/safety.ts), and
 * every fact and metric is checked against what the turn read (domain/coach/grounding.ts).
 *
 * Blocks go to the wire in order. The first block not yet settled is the open one; later blocks
 * wait behind it. The open block is released by these rules:
 * - Clean (no pain word, no context phrase and no violation in its text so far): released at each
 *   sentence end. With HOLD_CAP characters held and no sentence end, it is released only up to
 *   the last clause boundary that leaves at least MAX_PATTERN_CHARS held, and that held overlap is
 *   scanned again with what follows. Every banned pattern is at most MAX_PATTERN_CHARS long, so
 *   one that began in released text would already have been seen whole.
 * - A pain word, a context phrase or a violation in it: the block is held, unsent, to the end of
 *   the answer, and checked there with the whole answer as context. Released text never holds a
 *   pain word or a context phrase, so nothing already sent can become a violation later.
 * - Pain mode (the owner reported pain): context phrases are banned outright and every block is
 *   held to its own end, then checked. The answer must carry safety guidance: unless a replaced
 *   block already gave it, safeGuidance is appended with this turn's alternatives
 *   (ALTERNATIVES_TOOL), or the generic gentler option.
 * A metric's method is scanned with its block's text, and a held block starts without it: its
 * method reaches the wire only with its completion, once the block has passed.
 * A block that fails is replaced (block_replaced) before any more of it is sent: the first by the
 * safe guidance, any later one by SAFETY_REMOVED. A fact or metric that is not grounded becomes a
 * note marked UNCHECKED, without its links; a direct answer (serverWritten) is not checked, as the
 * server wrote it from the records it read. Each change is an intervention, stored by the turn as
 * a '_policy' row with codes and counts only.
 */
import type { BetaUserMessageParam } from '@anthropic-ai/sdk/resources/beta/messages';
import {
	answerTag,
	parseAnswer,
	type AnswerBlock,
	type AnswerParserEvent
} from '../../domain/coach/answer.ts';
import type { CoachEvent, CompletedBlock } from '../../domain/coach/events.ts';
import { checkGrounding, collectEvidence, type Evidence } from '../../domain/coach/grounding.ts';
import { parseRich } from '../../domain/coach/markdown.ts';
import type { RichBlock, RichInline, RichNode } from '../../domain/coach/rich.ts';
import {
	hasContextPhrase,
	hasPainWord,
	MAX_PATTERN_CHARS,
	safeGuidance,
	scanAdvice,
	type GentlerOption
} from '../../domain/coach/safety.ts';
import { clauseBoundaries, sentenceBoundaries } from '../../domain/coach/sentences.ts';
import type { AnswerBlockKind } from '../../domain/coach/vocabulary.ts';
import type { BodyArea } from '../../domain/profile/catalog.ts';
import type { ToolCallOutcome } from './tools/execute.ts';

/** Held characters at which a clean block without a sentence end is released at a clause. */
export const HOLD_CAP = 240;

/** The tool whose results name the gentler options safe guidance offers. */
export const ALTERNATIVES_TOOL = 'get_exercise_alternatives';

/** What a fact or metric that could not be checked says first, as a note. */
export const UNCHECKED = 'Not checked against your data.';

/** What a second failing block becomes, once the safe guidance is already in the answer. */
export const SAFETY_REMOVED = 'Part of this answer was removed by the safety check.';

export interface PolicyInput {
	painMode: boolean;
	/** Where the owner said it hurts, for the guidance's heading. */
	area?: BodyArea | null;
	/** The segment's memory preamble, as stored: the snapshot's ids are citable too. */
	preamble: BetaUserMessageParam;
	/** The server wrote the answer from the records it read (direct.ts): grounding checks a model's claims, not these. */
	serverWritten?: boolean;
}

/** A change the policy made, stored as a '_policy' tool-call row. */
export interface PolicyIntervention {
	block: number;
	reason: 'safety' | 'ungrounded';
	/** Codes and counts only, never text. */
	detail: Record<string, unknown>;
}

export interface OutputPolicy {
	/** Parser events in; the events the wire may carry now. */
	push(events: readonly AnswerParserEvent[]): CoachEvent[];
	/** A step's tool outcomes: what this turn's facts may cite. */
	observe(outcomes: readonly ToolCallOutcome[]): void;
	/** The answer has ended: whatever was held, and any block the answer still owes. */
	end(): CoachEvent[];
	/** The interventions so far. */
	readonly interventions: readonly PolicyIntervention[];
	/** The settled blocks, in the answer grammar, as the owner saw them (for the stored row). */
	answerText(blocks: readonly number[]): string;
}

interface OpenBlock {
	block: number;
	kind: AnswerBlockKind;
	method: string | null;
	started: boolean;
	/** The display text received so far. */
	text: string;
	/** How much of it the wire has. */
	released: number;
	/** Held unsent to the end of the answer (or of the block, in pain mode). */
	held: boolean;
	done: AnswerBlock | null;
}

/** The memory snapshot inside the stored preamble, or null when it cannot be read. */
function snapshotOf(preamble: BetaUserMessageParam): unknown {
	const content = preamble.content;
	const text =
		typeof content === 'string'
			? content
			: content.map((block) => (block.type === 'text' ? block.text : '')).join('');
	try {
		return JSON.parse(text.slice(text.indexOf('\n') + 1));
	} catch {
		return null;
	}
}

/** The gentler options in an alternatives result: its items (or alternatives), by name. */
function alternativesIn(output: unknown): GentlerOption[] {
	const record = (output ?? {}) as Record<string, unknown>;
	const items = Array.isArray(record.items)
		? record.items
		: Array.isArray(record.alternatives)
			? record.alternatives
			: [];
	return items.flatMap((item): GentlerOption[] => {
		const each = (item ?? {}) as Record<string, unknown>;
		const named = each.name as unknown;
		const name =
			typeof named === 'string'
				? named
				: typeof (named as { value?: unknown } | null)?.value === 'string'
					? (named as { value: string }).value
					: null;
		if (!name) return [];
		const id = [each.exerciseId, each.id].find((value) => typeof value === 'string') as
			string | undefined;
		return [id ? { id, name } : { name }];
	});
}

/** The tree with each ref as plain words: an unchecked note links nowhere. */
function unlinked(nodes: readonly RichNode[]): RichNode[] {
	return nodes.map((node): RichNode => {
		if (node.type === 'ref') return { type: 'text', text: node.label };
		if ('children' in node) return { ...node, children: unlinked(node.children) } as RichNode;
		return node;
	});
}

/** What a block says, for the safety scan: its method (a metric's), then its text. */
const said = (block: { method: string | null; text: string }) =>
	block.method ? `${block.method}\n${block.text}` : block.text;

/** Text the grammar reads literally. */
const escaped = (text: string) => text.replace(/[[\]\\]/g, (char) => `\\${char}`);

export function createOutputPolicy(input: PolicyInput): OutputPolicy {
	const { painMode } = input;
	const snapshot = snapshotOf(input.preamble);
	const documents: unknown[] = snapshot === null ? [] : [snapshot];
	let evidence: Evidence = collectEvidence(documents);
	const alternatives: GentlerOption[] = [];
	const interventions: PolicyIntervention[] = [];
	const blocks: OpenBlock[] = [];
	/** Each settled block as the grammar writes it. */
	const settled = new Map<number, string>();
	let cursor = 0;
	let guided = false;
	let ended = false;

	const guidance = () => parseAnswer(safeGuidance({ area: input.area, alternatives }))[0]!;

	const complete = (
		out: CoachEvent[],
		open: OpenBlock,
		block: Pick<AnswerBlock, 'kind' | 'method' | 'raw' | 'refs'>,
		grounded: boolean,
		replaced: PolicyIntervention['reason'] | null,
		ast: RichNode[] = parseRich(block.raw)
	) => {
		const completed: CompletedBlock = {
			block: open.block,
			kind: block.kind,
			method: block.method,
			ast,
			sources: block.refs,
			grounded
		};
		out.push(
			replaced
				? { type: 'block_replaced', reason: replaced, ...completed }
				: { type: 'block_completed', ...completed }
		);
		settled.set(open.block, `${answerTag(block.kind, block.method ?? undefined)} ${block.raw}`);
	};

	/** Send what is left of a block that passed, then settle it. */
	const pass = (out: CoachEvent[], open: OpenBlock, done: AnswerBlock) => {
		const rest = open.text.slice(open.released);
		if (rest) out.push({ type: 'text_delta', block: open.block, text: rest });
		open.released = open.text.length;
		if (input.serverWritten) return complete(out, open, done, true, null);
		const grounding = checkGrounding(done, evidence);
		if (grounding.grounded) return complete(out, open, done, true, null);
		interventions.push({
			block: open.block,
			reason: 'ungrounded',
			detail: {
				uncited: grounding.uncited,
				unknownRefs: grounding.unknownRefs.length,
				unmatchedNumbers: grounding.unmatchedNumbers.length
			}
		});
		const words = `${UNCHECKED} ${escaped(done.text)}`;
		const ast: RichBlock[] = [
			{ type: 'paragraph', children: [{ type: 'text', text: UNCHECKED }] },
			...(unlinked(parseRich(done.raw)) as RichBlock[])
		];
		complete(
			out,
			open,
			{ kind: 'note', method: null, raw: words, refs: [] },
			false,
			'ungrounded',
			ast
		);
	};

	/** Replace a failing block before any more of it is sent. */
	const replace = (out: CoachEvent[], open: OpenBlock, patterns: string[]) => {
		const first = !guided;
		guided = true;
		interventions.push({
			block: open.block,
			reason: 'safety',
			detail: { action: first ? 'replaced' : 'removed', patterns }
		});
		if (first) return complete(out, open, guidance(), true, 'safety');
		const note = { kind: 'note' as const, method: null, raw: SAFETY_REMOVED, refs: [] };
		const ast: RichInline[] = [{ type: 'text', text: SAFETY_REMOVED }];
		complete(out, open, note, true, 'safety', [{ type: 'paragraph', children: ast }]);
	};

	/** Check a finished block with the given context: pass it or replace it. */
	const decide = (out: CoachEvent[], open: OpenBlock, painContext: boolean) => {
		const done = open.done!;
		const violations = scanAdvice(said(done), { painContext });
		if (violations.length > 0)
			return replace(out, open, [...new Set(violations.map((violation) => violation.id))]);
		pass(out, open, done);
	};

	/** Whether the block's text so far keeps it clean. */
	const clean = (open: OpenBlock) =>
		!painMode &&
		!hasPainWord(said(open)) &&
		!hasContextPhrase(said(open)) &&
		scanAdvice(said(open), { painContext: false }).length === 0;

	/** Where a clean, unfinished block may be released up to, or null. */
	const cut = (open: OpenBlock): number | null => {
		const { text, released } = open;
		const sentence = sentenceBoundaries(text).findLast((at) => at > released);
		if (sentence !== undefined) return sentence;
		if (text.length - released < HOLD_CAP) return null;
		const clause = clauseBoundaries(text).findLast(
			(at) => at > released && text.length - at >= MAX_PATTERN_CHARS
		);
		return clause ?? null;
	};

	/** Move the wire forward as far as the rules allow. */
	const pump = (out: CoachEvent[]) => {
		for (;;) {
			const open = blocks[cursor];
			if (!open) return;
			if (!open.held && !clean(open)) open.held = true;
			if (!open.started) {
				out.push({
					type: 'block_started',
					block: open.block,
					kind: open.kind,
					method: open.held ? null : open.method
				});
				open.started = true;
			}
			if (open.held) {
				// Pain mode decides at the block's end; otherwise the whole answer is needed.
				if (!open.done || !(painMode || ended)) return;
				decide(out, open, painMode || answerNamesPain());
			} else if (open.done) {
				pass(out, open, open.done);
			} else {
				const at = cut(open);
				if (at !== null && at > open.released) {
					out.push({
						type: 'text_delta',
						block: open.block,
						text: open.text.slice(open.released, at)
					});
					open.released = at;
				}
				return;
			}
			cursor += 1;
		}
	};

	const answerNamesPain = () => blocks.some((open) => hasPainWord(said(open.done ?? open)));

	return {
		push(events) {
			for (const event of events) {
				if (event.type === 'block_started')
					blocks[event.block] = {
						block: event.block,
						kind: event.kind,
						method: event.method,
						started: false,
						text: '',
						released: 0,
						held: false,
						done: null
					};
				else if (event.type === 'text') blocks[event.block]!.text += event.text;
				else {
					const open = blocks[event.block]!;
					open.text = event.text;
					open.done = event;
				}
			}
			const out: CoachEvent[] = [];
			pump(out);
			return out;
		},
		observe(outcomes) {
			for (const outcome of outcomes) {
				if (outcome.status !== 'succeeded') continue;
				documents.push(outcome.output);
				if (outcome.name === ALTERNATIVES_TOOL)
					alternatives.push(...alternativesIn(outcome.output));
			}
			evidence = collectEvidence(documents);
		},
		end() {
			if (ended) return [];
			ended = true;
			const out: CoachEvent[] = [];
			pump(out);
			if (painMode && !guided) {
				guided = true;
				const block = guidance();
				const open: OpenBlock = {
					block: blocks.length,
					kind: 'safety',
					method: null,
					started: true,
					text: block.text,
					released: block.text.length,
					held: false,
					done: block
				};
				blocks.push(open);
				out.push({ type: 'block_started', block: open.block, kind: 'safety', method: null });
				out.push({ type: 'text_delta', block: open.block, text: block.text });
				complete(out, open, block, true, null);
				interventions.push({
					block: open.block,
					reason: 'safety',
					detail: { action: 'appended', alternatives: alternatives.length }
				});
				cursor = blocks.length;
			}
			return out;
		},
		get interventions() {
			return interventions;
		},
		answerText(indices) {
			return indices.flatMap((index) => settled.get(index) ?? []).join('\n\n');
		}
	};
}
