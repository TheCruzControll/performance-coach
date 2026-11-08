/**
 * Grounding (the M5 plan, "answers are labelled and grounded"): whether a [fact] or [metric]
 * block rests on what this turn actually read. Server-only; imported by path.
 *
 * Evidence is collected from documents: each tool output of the turn, and the segment's memory
 * snapshot. From each it keeps the source refs it carries (any object with a known `type` and a
 * string `id`), the ISO dates it names, and every quantity in it, filed under each ref of that
 * document. A quantity keeps its unit when the document gives one (a `{ value, unit }` object, or
 * a unit written after the number in a string); a number given without one (any other JSON
 * number) matches a claim in any unit.
 *
 * A block is grounded when:
 * - it cites at least one ref, and every ref it cites is one the evidence holds (a date ref, a day
 *   the evidence names)
 * - every number it shows with a unit ('102.5 kg', '5 km', '3 sets', '85%'), read from the text
 *   as rendered (markdown resolved), appears with that unit in a document one of its refs came
 *   from
 * Only facts and metrics are checked; other blocks are not claims about the records.
 */
import type { AnswerBlock } from './answer.ts';
import { parseRich } from './markdown.ts';
import type { RichNode } from './rich.ts';
import { isSourceType, type SourceRef } from './sources.ts';

export interface Evidence {
	/** `type:id` of every ref the documents carry. */
	refs: ReadonlySet<string>;
	/** For each ref key, the quantities of the documents that carry it: `102.5 kg`, or a bare `3`. */
	numbers: ReadonlyMap<string, ReadonlySet<string>>;
	/** Every `YYYY-MM-DD` the documents name. */
	dates: ReadonlySet<string>;
}

export interface Grounding {
	grounded: boolean;
	/** The block cites no ref at all. */
	uncited: boolean;
	/** Refs the evidence does not hold, as `type:id`. */
	unknownRefs: string[];
	/** Numbers written with a unit that no cited document holds, as written. */
	unmatchedNumbers: string[];
}

/** The block kinds whose claims are checked. */
export const CHECKED_KINDS: ReadonlySet<string> = new Set(['fact', 'metric']);

const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
/**
 * A number and the unit after it, if any. Longer units come first so `mins` is not read as `m`;
 * the unit must end the word (or be `%`), so `5 kgs` and `5 mph` are not misread.
 */
const QUANTITY =
	/(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(?: ?(%|(?:kgs?|lbs?|km|kms|mi|miles?|metres?|meters?|m|mins?|minutes?|secs?|seconds?|s|hrs?|hours?|h|reps?|sets?|sessions?|workouts?|runs?|days?|weeks?|bpm|kcal|rpe)\b))?/gi;
/** Unit spellings that differ after the plural is dropped. */
const UNIT_NAMES: Readonly<Record<string, string>> = {
	mile: 'mi',
	metre: 'm',
	meter: 'm',
	minute: 'min',
	sec: 's',
	second: 's',
	hr: 'h',
	hour: 'h'
};

export const refKey = (ref: Pick<SourceRef, 'type' | 'id'>) => `${ref.type}:${ref.id}`;

/** A number as compared: commas dropped, trailing zeros gone (`1,000.50` is `1000.5`). */
function canonical(text: string): string {
	return String(Number(text.replace(/,/g, '')));
}

/** A unit as compared: lower case, singular, one spelling (`Kgs` is `kg`, `minutes` is `min`). */
function unitOf(text: string): string {
	const lower = text.trim().toLowerCase();
	const single = lower.length > 2 ? lower.replace(/s$/, '') : lower;
	return UNIT_NAMES[single] ?? single;
}

/** What the reader sees of a rendered tree: markdown resolved, each ref as its label. */
function shown(nodes: readonly RichNode[]): string {
	return nodes
		.map((node) => {
			if (node.type === 'text' || node.type === 'code') return node.text;
			if (node.type === 'ref') return node.label;
			const inner = shown(node.children as RichNode[]);
			return node.type === 'emphasis' || node.type === 'strong' || node.type === 'link'
				? inner
				: `${inner}\n`;
		})
		.join('');
}

/** The evidence in `documents`: each tool output, and the memory snapshot, is one document. */
export function collectEvidence(documents: readonly unknown[]): Evidence {
	const refs = new Set<string>();
	const numbers = new Map<string, Set<string>>();
	const dates = new Set<string>();
	for (const document of documents) {
		const own = { refs: new Set<string>(), numbers: new Set<string>() };
		walk(document, own, dates);
		for (const key of own.refs) {
			refs.add(key);
			const filed = numbers.get(key) ?? new Set<string>();
			for (const number of own.numbers) filed.add(number);
			numbers.set(key, filed);
		}
	}
	return { refs, numbers, dates };
}

function walk(
	value: unknown,
	own: { refs: Set<string>; numbers: Set<string> },
	dates: Set<string>
): void {
	if (typeof value === 'number') {
		if (Number.isFinite(value)) own.numbers.add(String(value));
		return;
	}
	if (typeof value === 'string') {
		for (const [date] of value.matchAll(ISO_DATE)) dates.add(date);
		for (const [, number = '', unit] of value.matchAll(QUANTITY))
			own.numbers.add(unit ? `${canonical(number)} ${unitOf(unit)}` : canonical(number));
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) walk(item, own, dates);
		return;
	}
	if (!value || typeof value !== 'object') return;
	const record = value as Record<string, unknown>;
	const { type, id } = record;
	if (typeof type === 'string' && isSourceType(type) && typeof id === 'string' && id !== '')
		own.refs.add(refKey({ type, id }));
	// A value with its unit (a metric) is that quantity, never a bare number.
	const paired =
		typeof record.value === 'number' &&
		Number.isFinite(record.value) &&
		typeof record.unit === 'string';
	if (paired) own.numbers.add(`${record.value as number} ${unitOf(record.unit as string)}`);
	for (const [key, child] of Object.entries(record))
		if (!(paired && key === 'value')) walk(child, own, dates);
}

/** Whether `block`'s refs and quantities are all in `evidence`; unchecked kinds always are. */
export function checkGrounding(
	block: Pick<AnswerBlock, 'kind' | 'raw' | 'refs'>,
	evidence: Evidence
): Grounding {
	if (!CHECKED_KINDS.has(block.kind))
		return { grounded: true, uncited: false, unknownRefs: [], unmatchedNumbers: [] };
	const known = (ref: SourceRef) =>
		ref.type === 'date' ? evidence.dates.has(ref.id) : evidence.refs.has(refKey(ref));
	const unknownRefs = [...new Set(block.refs.filter((ref) => !known(ref)).map(refKey))];
	const cited = new Set<string>();
	for (const ref of block.refs)
		for (const number of evidence.numbers.get(refKey(ref)) ?? []) cited.add(number);
	const unmatchedNumbers = [...shown(parseRich(block.raw)).matchAll(QUANTITY)]
		.filter(([, number = '', unit]) => {
			if (!unit) return false;
			const value = canonical(number);
			return !cited.has(`${value} ${unitOf(unit)}`) && !cited.has(value);
		})
		.map(([written]) => written);
	const uncited = block.refs.length === 0;
	return {
		grounded: !uncited && unknownRefs.length === 0 && unmatchedNumbers.length === 0,
		uncited,
		unknownRefs,
		unmatchedNumbers
	};
}
