/**
 * The light markdown an answer may use, parsed on the server into the rich-text tree the screen
 * renders as elements (./rich.ts). No markdown library is involved and no HTML is made at any
 * step: the browser receives the finished tree in block_completed (./events.ts), so no answer,
 * tool output or stored note can inject markup. Server-only; imported by path, never through
 * ./index.ts (scripts/coach-index-imports.test.ts).
 *
 * It reads an answer block's raw text (answer.ts's AnswerBlock.raw), refs and escapes included:
 * - paragraphs, split by blank lines; a single newline stays in the text as '\n'
 * - *emphasis* or _emphasis_ and **strong** or __strong__. A run of delimiters inside a word
 *   stays as written (so 3*5*2 and snake_case do), and so does a run of three or more.
 * - `code` on one line, as written, except that refs read as their labels and the grammar's
 *   escapes resolve, as they do everywhere else in the answer
 * - bullet (-, * or +) and numbered (1. or 1)) lists, nested by indentation. A numbered list
 *   starts at 1, since the tree carries no start number. A list may follow a paragraph line
 *   directly; any other line continues the item above it, unless a blank line came first.
 * - [words](path) when the path is exactly one sourceAction builds for some ref (./sources.ts)
 * - refs, [[type:id|label]], as ref nodes, and a backslash before ASCII punctuation
 *
 * Everything else stays literal text: HTML, entities, headings, quotes, fences, tables, images,
 * autolinks, and external, protocol-relative, javascript: or data: links. Size and nesting are
 * bounded by RICH_LIMITS, so the worst tree still fits one SSE frame. The tree depends only on
 * the text, never on how it streamed.
 */
import type { RichBlock, RichInline, RichItem, RichList, RichNode } from './rich.ts';
import { parseRef, REF_ID_MAX, REF_LABEL_MAX, SOURCE_TYPES, sourceAction } from './sources.ts';
import type { SourceRef } from './sources.ts';

export const RICH_LIMITS = {
	/** Characters parsed; longer text is cut at a space near the limit and ends with '…'. */
	chars: 4000,
	/** Nodes in one tree; a block that would need more shows as one paragraph of plain text. */
	nodes: 300,
	/** Emphasis, strong and links inside one another; a deeper one stays as written. */
	inlineDepth: 3,
	/** Lists inside lists; a deeper item continues the item above it. */
	listDepth: 3,
	/** The longest code span, link words and link path; a longer one stays as written. */
	code: 200,
	linkText: 200,
	href: 300
} as const;

/** How far back from the limit a cut looks for a space before it cuts mid-word. */
const CUT_LOOKBACK = 80;
const REF_MAX =
	Math.max(...SOURCE_TYPES.map((type) => type.length)) + REF_ID_MAX + REF_LABEL_MAX + 2;
const PUNCTUATION = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;
const ITEM = /^([ \t]*)(?:[-*+]|(\d{1,9})[.)])[ \t]+(\S.*)$/;
const LINK = new RegExp(
	`\\[((?:\\\\[^\\n]|[^\\\\[\\]\\n]){1,${RICH_LIMITS.linkText}})\\]\\(([^\\s()<>]{1,${RICH_LIMITS.href}})\\)`,
	'y'
);

type Delimiter = { t: 'delim'; text: string; open: boolean; close: boolean };
type Link = { t: 'link'; href: string; words: string; raw: string };
type Token = { t: 'text'; text: string } | { t: 'leaf'; node: RichInline } | Link | Delimiter;

interface ItemDraft {
	lines: string[];
	lists: ListDraft[];
}
interface ListDraft {
	ordered: boolean;
	indent: number;
	items: ItemDraft[];
}
type BlockDraft = { lines: string[] } | ListDraft;

export function parseRich(text: string): RichBlock[] {
	const kept = cut(text.replace(/\r\n?/g, '\n'));
	const tree = drafts(kept).map(toBlock);
	if (size(tree) <= RICH_LIMITS.nodes) return tree;
	return [{ type: 'paragraph', children: [{ type: 'text', text: plain(kept.trim()) }] }];
}

function cut(text: string): string {
	if (text.length <= RICH_LIMITS.chars) return text;
	let head = text.slice(0, RICH_LIMITS.chars - 1);
	const space = Math.max(head.lastIndexOf(' '), head.lastIndexOf('\n'));
	if (space >= head.length - CUT_LOOKBACK) head = head.slice(0, space);
	else if (/[\ud800-\udbff]$/.test(head)) head = head.slice(0, -1);
	return `${head.trimEnd()}…`;
}

const size = (nodes: readonly RichNode[]): number =>
	nodes.reduce((sum, node) => sum + 1 + ('children' in node ? size(node.children) : 0), 0);

const isRule = (words: string) => /^(?:-{3,}|\*{3,}|_{3,})$/.test(words.replace(/[ \t]/g, ''));
const width = (space: string) => space.replace(/\t/g, '    ').length;

/** The paragraphs and lists, each paragraph and item as its trimmed lines. */
function drafts(text: string): BlockDraft[] {
	const blocks: BlockDraft[] = [];
	let paragraph: string[] | null = null;
	let open: ListDraft[] = []; // the open lists, outermost first
	let blank = false;

	/** Opens `list` at `level` (1 is the top), under the last item of the list above it. */
	const begin = (list: ListDraft, level: number) => {
		if (level === 1) blocks.push(list);
		else open[level - 2]!.items.at(-1)!.lists.push(list);
		open.length = level - 1;
		open.push(list);
	};

	/** Adds an item line to the lists, or says no when the line must be read as text. */
	const place = ([, space = '', number, content = '']: RegExpExecArray): boolean => {
		const ordered = number !== undefined;
		const indent = width(space);
		const item: ItemDraft = { lines: [content.trim()], lists: [] };
		let level = open.length;
		while (level > 1 && open[level - 2]!.indent >= indent) level--;
		const list = open[level - 1];
		if (list && indent <= list.indent && list.ordered === ordered) {
			list.items.push(item);
			open.length = level;
		} else if (ordered && Number(number) !== 1) return false;
		else if (!list || indent <= list.indent) begin({ ordered, indent, items: [item] }, level || 1);
		else if (level < RICH_LIMITS.listDepth) begin({ ordered, indent, items: [item] }, level + 1);
		else return false;
		return true;
	};

	for (const line of text.split('\n')) {
		const words = line.trim();
		const afterBlank = blank;
		blank = !words;
		if (!words) {
			paragraph = null;
			continue;
		}
		const item = isRule(words) ? null : ITEM.exec(line);
		if (item && place(item)) {
			paragraph = null;
			continue;
		}
		const last = open.at(-1)?.items.at(-1);
		if (last && !afterBlank) {
			last.lines.push(words);
			continue;
		}
		open = [];
		if (paragraph) paragraph.push(words);
		else blocks.push({ lines: (paragraph = [words]) });
	}
	return blocks;
}

function toList(list: ListDraft): RichList {
	return {
		type: 'list',
		ordered: list.ordered,
		children: list.items.map((item): RichItem => ({
			type: 'item',
			children: [...inlines(item.lines.join('\n'), 0), ...item.lists.map(toList)]
		}))
	};
}

const toBlock = (draft: BlockDraft): RichBlock =>
	'items' in draft
		? toList(draft)
		: { type: 'paragraph', children: inlines(draft.lines.join('\n'), 0) };

function inlines(text: string, depth: number): RichInline[] {
	const tokens = tokenize(text);
	return build(tokens, pair(tokens), 0, tokens.length, depth);
}

const run = (text: string, at: number) => {
	let end = at;
	while (text[end] === text[at]) end++;
	return end - at;
};

function tokenize(text: string): Token[] {
	const tokens: Token[] = [];
	let words = '';
	const push = (token: Token) => {
		if (words) tokens.push({ t: 'text', text: words });
		words = '';
		tokens.push(token);
	};
	for (let at = 0; at < text.length;) {
		const char = text[at]!;
		const next = text[at + 1];
		const ref = char === '[' && next === '[' ? refAt(text, at) : null;
		// An image, ![words](path), stays as written.
		const link = char === '[' && !ref && text[at - 1] !== '!' ? linkAt(text, at) : null;
		if (char === '\\' && next !== undefined && PUNCTUATION.test(next)) {
			words += next;
			at += 2;
		} else if (char === '`') {
			const n = run(text, at);
			const code = codeAt(text, at, n);
			if (code) push({ t: 'leaf', node: { type: 'code', text: code.text } });
			else words += text.slice(at, at + n);
			at = code ? code.end : at + n;
		} else if (ref) {
			push({ t: 'leaf', node: { type: 'ref', ref: ref.ref, label: ref.label } });
			at = ref.end;
		} else if (link) {
			push(link);
			at += link.raw.length;
		} else if (char === '*' || char === '_') {
			const n = run(text, at);
			const before = text[at - 1] ?? ' ';
			const after = text[at + n] ?? ' ';
			const open = !SPACE.test(after) && !WORD.test(before);
			const close = !SPACE.test(before) && !WORD.test(after);
			if (n <= 2 && (open || close))
				push({ t: 'delim', text: text.slice(at, at + n), open, close });
			else words += text.slice(at, at + n);
			at += n;
		} else {
			words += char;
			at++;
		}
	}
	if (words) tokens.push({ t: 'text', text: words });
	return tokens;
}

/** A code span of `n` backticks at `at`, closed by the next run of exactly `n` on its line. */
function codeAt(text: string, at: number, n: number) {
	for (let end = at + n; end < text.length && end - at - n <= RICH_LIMITS.code;) {
		if (text[end] === '\n') return null;
		if (text[end] !== '`') {
			end++;
			continue;
		}
		const m = run(text, end);
		if (m === n) {
			const inner = text.slice(at + n, end);
			const padded = inner.startsWith(' ') && inner.endsWith(' ') && inner.trim() !== '';
			return { text: plain(padded ? inner.slice(1, -1) : inner), end: end + n };
		}
		end += m;
	}
	return null;
}

/** A ref parseRef accepts at `at`, with the words it shows: answer.ts's display of it. */
function refAt(text: string, at: number): { ref: SourceRef; label: string; end: number } | null {
	const close = text.slice(at + 2, at + REF_MAX + 4).indexOf(']]');
	const inner = close < 0 ? '' : text.slice(at + 2, at + 2 + close);
	const ref = /[[\]\n]/.test(inner) ? null : parseRef(inner);
	if (!ref) return null;
	return { ref, label: ref.label ?? (ref.type === 'date' ? ref.id : ''), end: at + close + 4 };
}

function linkAt(text: string, at: number): Link | null {
	LINK.lastIndex = at;
	const match = LINK.exec(text);
	if (!match) return null;
	const [raw, words = '', href = ''] = match;
	return words.trim() && isAppLink(href) ? { t: 'link', href, words, raw } : null;
}

/** Whether `href` is exactly a path sourceAction builds for some ref: the only links kept. */
function isAppLink(href: string): boolean {
	let id: string;
	try {
		id = decodeURIComponent(href.slice(href.lastIndexOf('/') + 1));
	} catch {
		return false; // a malformed escape
	}
	return SOURCE_TYPES.some((type) => {
		const action = sourceAction({ type, id, workoutId: id });
		return action?.kind === 'link' && action.href === href;
	});
}

/** The words with no markdown: refs as their labels and the grammar's escapes resolved. */
function plain(text: string): string {
	let out = '';
	for (let at = 0; at < text.length;) {
		const ref = text.startsWith('[[', at) ? refAt(text, at) : null;
		if (ref) {
			out += ref.label;
			at = ref.end;
		} else if (text[at] === '\\' && '[]\\'.includes(text[at + 1] ?? 'x')) {
			out += text[at + 1];
			at += 2;
		} else out += text[at++];
	}
	return out;
}

/**
 * Pairs emphasis runs as CommonMark's delimiter stack does: a closing run takes the nearest open
 * run of the same kind, and the open runs between them stay text, so pairs never cross. `floor`
 * remembers, per kind, the stack height below which no opener of that kind is left, which keeps
 * the pairing linear.
 */
function pair(tokens: Token[]): Map<number, number> {
	const pairs = new Map<number, number>();
	const stack: number[] = [];
	const floor = new Map<string, number>();
	tokens.forEach((token, at) => {
		if (token.t !== 'delim') return;
		if (token.close) {
			for (let k = stack.length - 1; k >= (floor.get(token.text) ?? 0); k--) {
				if ((tokens[stack[k]!] as Delimiter).text !== token.text) continue;
				pairs.set(stack[k]!, at);
				stack.length = k;
				for (const [kind, height] of floor) floor.set(kind, Math.min(height, k));
				return;
			}
			floor.set(token.text, stack.length);
		}
		if (token.open) stack.push(at);
	});
	return pairs;
}

function build(
	tokens: Token[],
	pairs: Map<number, number>,
	from: number,
	to: number,
	depth: number
): RichInline[] {
	const out: RichInline[] = [];
	const text = (words: string) => {
		const last = out.at(-1);
		if (last?.type === 'text') last.text += words;
		else out.push({ type: 'text', text: words });
	};
	const nest = depth < RICH_LIMITS.inlineDepth;
	for (let at = from; at < to; at++) {
		const token = tokens[at]!;
		const close = pairs.get(at);
		if (token.t === 'text') text(token.text);
		else if (token.t === 'leaf') out.push(token.node);
		else if (token.t === 'link' && nest)
			out.push({ type: 'link', href: token.href, children: inlines(token.words, depth + 1) });
		else if (token.t === 'link') text(token.raw);
		else if (close !== undefined && nest) {
			const children = build(tokens, pairs, at + 1, close, depth + 1);
			out.push({ type: token.text.length === 2 ? 'strong' : 'emphasis', children });
			at = close;
		} else text(token.text);
	}
	return out;
}
