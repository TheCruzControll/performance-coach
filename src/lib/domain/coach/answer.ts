/**
 * The labelled-answer grammar (PRD §12) and its incremental parser. It runs on the server, between
 * the model and the wire; the browser only receives the blocks, as events (./events.ts). Imported
 * by path, never through ./index.ts.
 *
 *   answer := lead? (tag content)*       a lead is unlabelled, so it is a note
 *   tag    := [fact] | [recommendation] | [safety] | [note] | [metric] | [metric method=…]
 *   ref    := [[type:id]] | [[type:id|label]]      (sources.ts, parseRef)
 *   escape := \[ | \] | \\                         a literal bracket or backslash
 *
 * A tag may stand anywhere and starts a block that runs to the next tag. A method holds no
 * brackets or newlines and may be quoted. Anything that does not complete a tag, a ref or an
 * escape is text, so an unknown ref type, '[3 sets]' or a markdown link stays as written. Each
 * block is trimmed, and an empty block is dropped. A bare [metric] is a metric whose method the
 * model left out: its method is null, and the output policy decides how to show it.
 *
 * The output never depends on how the text was chunked: at any position the parser either decides
 * exactly what the whole text would decide, or waits. It holds back only a tag, ref or escape that
 * could still complete (at most REF_MAX characters), a block's trailing whitespace, and a high
 * surrogate whose pair has not arrived.
 */
import { isSourceType, parseRef, REF_ID_MAX, REF_LABEL_MAX, SOURCE_TYPES } from './sources.ts';
import type { SourceRef } from './sources.ts';
import type { AnswerBlockKind } from './vocabulary.ts';

export const METHOD_MAX = 120;

const METHOD_PREFIX = 'metric method=';
const PLAIN_TAGS: readonly string[] = ['fact', 'recommendation', 'safety', 'note', 'metric'];
const TAG_MAX = METHOD_PREFIX.length + METHOD_MAX;
const REF_MAX =
	Math.max(...SOURCE_TYPES.map((type) => type.length)) + REF_ID_MAX + REF_LABEL_MAX + 2;

export interface AnswerBlock {
	/** Its index in the answer, from 0. */
	block: number;
	kind: AnswerBlockKind;
	/** How a metric was calculated; null for every other kind, and for a bare [metric]. */
	method: string | null;
	/** What the reader sees: escapes resolved and each ref as its label. */
	text: string;
	/** The block as the model wrote it, refs and escapes included, for the markdown parser. */
	raw: string;
	/** The refs it cites, in order. */
	refs: SourceRef[];
}

export type AnswerParserEvent =
	| { type: 'block_started'; block: number; kind: AnswerBlockKind; method: string | null }
	| { type: 'text'; block: number; text: string }
	| ({ type: 'block_completed' } & AnswerBlock);

export interface AnswerParser {
	push(delta: string): AnswerParserEvent[];
	/** Closes the open block; the parser takes no more text. */
	end(): AnswerParserEvent[];
	/** The blocks completed so far. */
	readonly blocks: readonly AnswerBlock[];
}

/** The tag that opens a block of `kind`, with a method made safe to sit inside it. */
export function answerTag(kind: AnswerBlockKind, method?: string): string {
	const clean = Array.from((method ?? '').replace(/[[\]]/g, '').replace(/\s+/g, ' ').trim())
		.slice(0, METHOD_MAX)
		.join('')
		.trim();
	return kind === 'metric' && clean ? `[${METHOD_PREFIX}${clean}]` : `[${kind}]`;
}

export function parseAnswer(text: string): AnswerBlock[] {
	const parser = createAnswerParser();
	parser.push(text);
	parser.end();
	return [...parser.blocks];
}

type Token =
	| { t: 'text'; display: string; raw: string }
	| { t: 'ref'; ref: SourceRef; display: string; raw: string }
	| { t: 'tag'; kind: AnswerBlockKind; method: string | null };

/** 'more': the text so far could still complete it; 'no': nothing that follows can. */
type Match<T> = T | 'no' | 'more';

/** Whether `inner` (after `[`) could still become a tag; prefix-closed, so a no is final. */
const tagViable = (inner: string) =>
	PLAIN_TAGS.some((tag) => tag.startsWith(inner)) ||
	METHOD_PREFIX.startsWith(inner) ||
	(inner.startsWith(METHOD_PREFIX) && inner.length <= TAG_MAX);

/** Whether `inner` (after `[[`) could still become a ref parseRef accepts; prefix-closed. */
function refViable(inner: string): boolean {
	const colon = inner.indexOf(':');
	if (colon < 0) return SOURCE_TYPES.some((type) => type.startsWith(inner));
	if (!isSourceType(inner.slice(0, colon))) return false;
	const [id = '', label, extra] = inner.slice(colon + 1).split('|');
	if (id.length > REF_ID_MAX || !/^([A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(id)) return false;
	if (label === undefined) return true;
	return id !== '' && extra === undefined && label.length <= REF_LABEL_MAX;
}

/** The candidate after an opening bracket: up to `]`, or to a newline, a `[` or the text's end. */
function candidate(text: string, from: number, max: number) {
	let end = from;
	while (end < text.length && end - from <= max && !'[]\n'.includes(text[end]!)) end++;
	return { inner: text.slice(from, end), end };
}

function matchTag(text: string, from: number, final: boolean): Match<Token & { end: number }> {
	const { inner, end } = candidate(text, from, TAG_MAX);
	if (!tagViable(inner)) return 'no';
	if (end >= text.length) return final ? 'no' : 'more';
	if (text[end] !== ']') return 'no';
	if (PLAIN_TAGS.includes(inner))
		return { t: 'tag', kind: inner as AnswerBlockKind, method: null, end: end + 1 };
	if (!inner.startsWith(METHOD_PREFIX)) return 'no';
	let method = inner.slice(METHOD_PREFIX.length).trim();
	if (method.length >= 2 && method.startsWith('"') && method.endsWith('"'))
		method = method.slice(1, -1).trim();
	return method ? { t: 'tag', kind: 'metric', method, end: end + 1 } : 'no';
}

function matchRef(text: string, from: number, final: boolean): Match<Token & { end: number }> {
	const { inner, end } = candidate(text, from, REF_MAX);
	if (!refViable(inner)) return 'no';
	if (end + 1 >= text.length) return final ? 'no' : 'more';
	if (text[end] !== ']' || text[end + 1] !== ']') return 'no';
	const ref = parseRef(inner);
	if (!ref) return 'no';
	const display = ref.label ?? (ref.type === 'date' ? ref.id : '');
	return { t: 'ref', ref, display, raw: text.slice(from - 2, end + 2), end: end + 2 };
}

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit < 0xdc00;

/** The token at `at`, or null when the text so far cannot decide it yet. */
function scan(text: string, at: number, final: boolean): (Token & { end: number }) | null {
	const unit = text[at];
	const literal = (display: string, raw = display) => ({
		t: 'text' as const,
		display,
		raw,
		end: at + raw.length
	});
	if (unit === '\\') {
		const next = text[at + 1];
		if (next === undefined) return final ? literal('\\') : null;
		return '[]\\'.includes(next) ? literal(next, `\\${next}`) : literal('\\');
	}
	if (unit === '[') {
		// A lone '[' at the end waits: matchTag answers 'more' until the next character arrives.
		const ref = text[at + 1] === '[';
		const match = ref ? matchRef(text, at + 2, final) : matchTag(text, at + 1, final);
		if (match === 'more') return null;
		return match === 'no' ? literal(ref ? '[[' : '[') : match;
	}
	let end = at;
	while (end < text.length && text[end] !== '\\' && text[end] !== '[') end++;
	if (end === text.length && !final && isHighSurrogate(text.charCodeAt(end - 1))) end--;
	return end > at ? literal(text.slice(at, end)) : null;
}

export function createAnswerParser(): AnswerParser {
	const blocks: AnswerBlock[] = [];
	let input = '';
	let ended = false;
	let label: { kind: AnswerBlockKind; method: string | null } = { kind: 'note', method: null };
	let open: AnswerBlock | null = null;
	let pending = ''; // the open block's trailing whitespace, sent only if more text follows
	let delta = '';

	const flush = (out: AnswerParserEvent[]) => {
		if (open && delta) out.push({ type: 'text', block: open.block, text: delta });
		delta = '';
	};

	const close = (out: AnswerParserEvent[]) => {
		if (!open) return;
		flush(out);
		blocks.push(open);
		out.push({ type: 'block_completed', ...open, refs: [...open.refs] });
		open = null;
		pending = '';
	};

	const content = (
		display: string,
		raw: string,
		ref: SourceRef | null,
		out: AnswerParserEvent[]
	) => {
		if (!open) {
			// Leading whitespace only ever comes in plain text, where raw and display are equal.
			const lead = display.length - display.trimStart().length;
			display = display.slice(lead);
			raw = raw.slice(lead);
			if (!display && !ref) return;
			open = { block: blocks.length, ...label, text: '', raw: '', refs: [] };
			out.push({ type: 'block_started', block: open.block, ...label });
		}
		if (ref) open.refs.push(ref);
		const trailing = ref ? '' : (/\s*$/.exec(display)?.[0] ?? '');
		if (!ref && trailing.length === display.length) {
			pending += display;
			return;
		}
		const body = pending + display.slice(0, display.length - trailing.length);
		open.text += body;
		open.raw += pending + raw.slice(0, raw.length - trailing.length);
		delta += body;
		pending = trailing;
	};

	const run = (final: boolean): AnswerParserEvent[] => {
		const out: AnswerParserEvent[] = [];
		let at = 0;
		while (at < input.length) {
			const token = scan(input, at, final);
			if (!token) break;
			if (token.t === 'tag') {
				close(out);
				label = { kind: token.kind, method: token.method };
			} else content(token.display, token.raw, token.t === 'ref' ? token.ref : null, out);
			at = token.end;
		}
		input = input.slice(at);
		flush(out);
		return out;
	};

	return {
		push(text) {
			if (ended) throw new Error('The answer has ended');
			input += text;
			return run(false);
		},
		end() {
			if (ended) return [];
			ended = true;
			const out = run(true);
			close(out);
			return out;
		},
		get blocks() {
			return blocks;
		}
	};
}
