/**
 * What a tool returns to the model: compact, canonical JSON, never a dump (PRD §4, the M5 brief).
 * - fact and metric carry the SourceRefs of the records they rest on, so answers cite them and
 *   the output policy checks them; a metric also says how code computed it.
 * - page lists at most PAGE_MAX items, says whether more exist and gives a cursor to them.
 * - untrusted wraps stored free text (notes, reasons, titles) as labelled data, never instructions.
 * - capOutput serialises canonically (sorted keys: the same result is the same bytes) within
 *   TURN_LIMITS.toolOutputBytes, dropping trailing items of the result's top-level lists (a page's
 *   items) and adding `truncated: true`, so a result that may be shortened states `truncated` in
 *   its output schema, as pageSchema does. Deeper lists (a fact around a page) are never shortened:
 *   a result it cannot shorten is a TOO_LARGE error.
 * - toolError is how a tool fails on purpose, with a code the model can act on.
 * The schemas state the same shapes in each tool's output schema.
 */
import * as z from 'zod/mini';
import { METHOD_MAX } from '../../../domain/coach/answer.ts';
import { TURN_LIMITS } from '../../../domain/coach/budgets.ts';
import { untrusted as wrap, type UntrustedText } from '../../../domain/coach/memory.ts';
import { SOURCE_TYPES, type SourceRef, type SourceType } from '../../../domain/coach/sources.ts';
import { canonicalJson } from '../../../domain/programming/random.ts';

export const PAGE_MAX = 20;
/** The most characters of one stored free-text field a result carries. */
export const UNTRUSTED_MAX = 500;

export interface Fact<T> {
	value: T;
	sources: SourceRef[];
}

export interface Metric {
	value: number;
	unit: string | null;
	/** How code computed it, as the answer's `[metric method=…]` repeats it. */
	method: string;
	sources: SourceRef[];
}

export interface Page<T> {
	items: T[];
	more: boolean;
	/** Where the next page starts, for the tool's cursor input; null at the end. */
	next: string | null;
}

export function fact<T>(value: T, source: SourceRef, ...more: SourceRef[]): Fact<T> {
	return { value, sources: [source, ...more] };
}

export function metric({ value, unit, method, sources }: Metric): Metric {
	if (!Number.isFinite(value)) throw new RangeError('A metric needs a finite value');
	if (!method.trim() || method.trim().length > METHOD_MAX)
		throw new RangeError(`A metric's method is 1 to ${METHOD_MAX} characters`);
	if (sources.length === 0) throw new RangeError('A metric needs at least one source');
	return { value, unit, method: method.trim(), sources };
}

export function page<T>(
	items: readonly T[],
	{ limit = PAGE_MAX, cursor }: { limit?: number; cursor?: (last: T) => string } = {}
): Page<T> {
	const shown = items.slice(0, Math.min(PAGE_MAX, Math.max(1, Math.floor(limit))));
	const more = items.length > shown.length;
	const last = shown.at(-1);
	return { items: shown, more, next: more && cursor && last ? cursor(last) : null };
}

export const untrusted = (text: string, max = UNTRUSTED_MAX): UntrustedText => wrap(text, max);

export class ToolError extends Error {
	readonly code: string;
	readonly details: Readonly<Record<string, unknown>>;

	constructor(code: string, message: string, details: Record<string, unknown> = {}) {
		if (!/^[A-Z][A-Z0-9_]*$/.test(code))
			throw new TypeError(`A tool error code is UPPER_SNAKE_CASE: ${code}`);
		super(message);
		this.name = 'ToolError';
		this.code = code;
		this.details = details;
	}
}

/** A failure the tool means, answered as is_error: `throw toolError('AMBIGUOUS', …)`. */
export const toolError = (code: string, message: string, details?: Record<string, unknown>) =>
	new ToolError(code, message, details);

export interface CappedOutput {
	/** What the model receives, as a value and as its canonical JSON. */
	value: unknown;
	json: string;
	truncated: boolean;
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;
const tooLarge = () =>
	toolError('TOO_LARGE', 'The result is too large; ask for fewer items or a shorter range');

export function capOutput(value: unknown, maxBytes = TURN_LIMITS.toolOutputBytes): CappedOutput {
	const json = canonicalJson(value);
	if (byteLength(json) <= maxBytes) return { value, json, truncated: false };
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw tooLarge();
	// A shortened page has no cursor (it would skip what was dropped): the model asks for less.
	const shorter: Record<string, unknown> = { ...value, truncated: true };
	if (typeof shorter.more === 'boolean') shorter.more = true;
	if ('next' in shorter) shorter.next = null;
	const lists = Object.keys(shorter).filter((key) => Array.isArray(shorter[key]));
	for (const key of lists) shorter[key] = [...(shorter[key] as unknown[])];
	for (;;) {
		const capped = canonicalJson(shorter);
		if (byteLength(capped) <= maxBytes) return { value: shorter, json: capped, truncated: true };
		const longest = lists
			.filter((key) => (shorter[key] as unknown[]).length > 0)
			.map((key) => ({ key, size: byteLength(canonicalJson(shorter[key])) }))
			.sort((a, b) => b.size - a.size)[0];
		if (!longest) throw tooLarge();
		(shorter[longest.key] as unknown[]).pop();
	}
}

export const sourceRefSchema = z.object({
	type: z.enum(SOURCE_TYPES as [SourceType, ...SourceType[]]),
	id: z.string(),
	label: z.optional(z.string()),
	date: z.optional(z.iso.date()),
	workoutId: z.optional(z.string())
});
export const untrustedSchema = z.object({
	untrusted_text: z.string(),
	truncated: z.optional(z.literal(true))
});
export const factSchema = <S extends z.ZodMiniType>(value: S) =>
	z.object({ value, sources: z.array(sourceRefSchema) });
export const metricSchema = z.object({
	value: z.number(),
	unit: z.nullable(z.string()),
	method: z.string(),
	sources: z.array(sourceRefSchema)
});
export const pageSchema = <S extends z.ZodMiniType>(item: S) =>
	z.object({
		items: z.array(item).check(z.maxLength(PAGE_MAX)),
		more: z.boolean(),
		next: z.nullable(z.string()),
		truncated: z.optional(z.literal(true))
	});
