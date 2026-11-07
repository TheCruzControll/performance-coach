/**
 * Where a coach answer, or an owner message, splits into sentences and clauses. The output gate
 * (agent/policy.ts) releases a clean block at a sentence end, or at the last clause boundary that
 * still holds MAX_PATTERN_CHARS (./safety.ts); the owner-text rules (./statements.ts,
 * ./safety.ts detectPain) read a message clause by clause. Zod-free and client-safe; imported by
 * path.
 *
 * A sentence ends after `.`, `!`, `?` or `…` (a run of them, then any closing quotes or brackets)
 * that whitespace follows, and at every line break, so each list item stands alone. A `.` does not
 * end one in a decimal (`2.5`), after an abbreviation (`e.g.`, `approx.`, `min.`), after an initial
 * (`J.`), or as a list marker at the start of a line (`1.`, `a.`). Nothing inside a `[[ref]]`
 * splits. A clause also ends after `,`, `;` or `:` that whitespace follows, before a dash set off by
 * spaces, and before a joining word (and, but, because, …) between spaces.
 *
 * Every boundary needs the character after it, so one found in a prefix of a text is a boundary
 * of every longer text too: a streaming caller never has to take one back. A text's own end is not
 * reported (the next delta may continue it); the split functions close their last span there.
 */

export interface TextSpan {
	start: number;
	end: number;
	/** text.slice(start, end), without the whitespace around it. */
	text: string;
}

/** Words a `.` may follow without ending the sentence, compared in lower case. */
export const ABBREVIATIONS: ReadonlySet<string> = new Set([
	'e.g',
	'i.e',
	'etc',
	'vs',
	'approx',
	'incl',
	'min',
	'mins',
	'sec',
	'secs',
	'hr',
	'hrs',
	'wk',
	'wks',
	'mo',
	'no',
	'cf',
	'ca',
	'a.m',
	'p.m',
	'dr',
	'mr',
	'mrs',
	'ms',
	'st'
]);

/** Words that join two clauses; a clause boundary falls just before one between spaces. */
export const CLAUSE_JOINERS: ReadonlySet<string> = new Set([
	'and',
	'but',
	'or',
	'so',
	'yet',
	'though',
	'although',
	'because',
	'while',
	'whereas',
	'however',
	'unless',
	'plus'
]);

const TERMINAL = /[.!?…]/;
const CLOSER = /[)\]"'”’»]/;
const SPACE = /\s/;
const WORD_CHAR = /[A-Za-z.]/;
const CLAUSE_PUNCT = /[,;:]/;
const DASHES = /[-–—]/;

/** Index pairs [open, close) of every `[[…]]`, which nothing inside may split. */
function refRanges(text: string): [number, number][] {
	const ranges: [number, number][] = [];
	let from = 0;
	for (;;) {
		const open = text.indexOf('[[', from);
		if (open < 0) return ranges;
		const close = text.indexOf(']]', open + 2);
		// An unclosed ref may still close in a later delta: nothing after it splits yet.
		const end = close < 0 ? text.length : close + 2;
		ranges.push([open, end]);
		from = end;
	}
}

function inside(ranges: readonly [number, number][], i: number): boolean {
	return ranges.some(([open, close]) => i > open && i < close);
}

/** Whether the `.` run starting at `dot` follows an abbreviation, an initial or a list marker. */
function dotKeepsSentence(text: string, dot: number): boolean {
	let k = dot;
	while (k > 0 && WORD_CHAR.test(text[k - 1] ?? '')) k -= 1;
	const word = text.slice(k, dot);
	if (ABBREVIATIONS.has(word.toLowerCase())) return true;
	const lineStart = text.lastIndexOf('\n', dot - 1) + 1;
	const before = text.slice(lineStart, dot);
	// A list marker: `1.`, `12.` or `a.` alone at the start of its line.
	if (/^\s{0,8}(?:\d{1,3}|[a-z])$/i.test(before)) return true;
	// An initial: one capital letter standing alone.
	return /^[A-Z]$/.test(word) && (k === 0 || SPACE.test(text[k - 1] ?? ''));
}

/** Offsets where a sentence ends, sorted: each is just after its punctuation (or at a newline). */
export function sentenceBoundaries(text: string): number[] {
	const refs = refRanges(text);
	const found: number[] = [];
	for (let i = 0; i < text.length; i += 1) {
		const char = text[i] ?? '';
		if (inside(refs, i)) continue;
		if (char === '\n') {
			// A sentence that ends at the line's end has its boundary already.
			if (found.at(-1) !== i) found.push(i);
			continue;
		}
		if (!TERMINAL.test(char)) continue;
		let j = i;
		while (j < text.length && TERMINAL.test(text[j] ?? '')) j += 1;
		const singleDot = text.slice(i, j) === '.';
		while (j < text.length && CLOSER.test(text[j] ?? '')) j += 1;
		const next = text[j];
		if (next !== undefined && SPACE.test(next) && !(singleDot && dotKeepsSentence(text, i))) {
			found.push(j);
		}
		i = j - 1;
	}
	return found;
}

/** Offsets where a clause ends, sorted; every sentence boundary is one. */
export function clauseBoundaries(text: string): number[] {
	const refs = refRanges(text);
	const found = new Set(sentenceBoundaries(text));
	for (let i = 0; i < text.length; i += 1) {
		const char = text[i] ?? '';
		const next = text[i + 1];
		if (next === undefined || inside(refs, i)) continue;
		if (CLAUSE_PUNCT.test(char) && SPACE.test(next)) found.add(i + 1);
		else if (DASHES.test(char) && SPACE.test(next) && i > 0 && SPACE.test(text[i - 1] ?? '')) {
			found.add(i);
		} else if (/[a-z]/i.test(char) && (i === 0 || SPACE.test(text[i - 1] ?? ''))) {
			let j = i;
			while (j < text.length && /[a-z]/i.test(text[j] ?? '')) j += 1;
			const after = text[j];
			if (i > 0 && after !== undefined && SPACE.test(after)) {
				if (CLAUSE_JOINERS.has(text.slice(i, j).toLowerCase())) found.add(i);
			}
			i = j - 1;
		}
	}
	return [...found].sort((a, b) => a - b);
}

function spans(text: string, cuts: readonly number[]): TextSpan[] {
	const out: TextSpan[] = [];
	let from = 0;
	for (const cut of [...cuts, text.length]) {
		const raw = text.slice(from, cut);
		const lead = raw.length - raw.trimStart().length;
		const trimmed = raw.trim();
		if (trimmed) out.push({ start: from + lead, end: from + lead + trimmed.length, text: trimmed });
		from = cut;
	}
	return out;
}

/** The text's sentences, trimmed, empty ones left out; the last runs to the text's end. */
export function splitSentences(text: string): TextSpan[] {
	return spans(text, sentenceBoundaries(text));
}

/** The text's clauses, trimmed, empty ones left out; the last runs to the text's end. */
export function splitClauses(text: string): TextSpan[] {
	return spans(text, clauseBoundaries(text));
}
