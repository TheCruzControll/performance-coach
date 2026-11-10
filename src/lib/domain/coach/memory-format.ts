/**
 * The coaching memory as the model reads it (the coach memory and proposals ADR): the data a
 * segment's preamble carries (agent/prompt/context.ts), built from a MemorySnapshot.
 *
 * - Canonical: keys in code-unit order and items in the snapshot's order, so the same snapshot
 *   is the same bytes and a segment's cached prefix never moves.
 * - Every stored string is wrapped as untrusted_text, at most MEMORY_TEXT_MAX characters. Only
 *   the strings the server itself writes stay bare: dates, vocabulary tokens and source ids
 *   (STRUCTURAL).
 * - At most MEMORY_MAX_BYTES of UTF-8. Over it, items are cut from the end of the
 *   lowest-priority section first (MEMORY_SECTION_PRIORITY), and `omitted` counts what each
 *   section lost, so the model knows to call a tool for the rest. The loaders list each section
 *   most relevant first (newest, highest rank), so the end is what matters least.
 *
 * Server-only: imported by path, never through domain/coach/index.ts.
 */
import { untrusted, type MemorySnapshot } from './memory.ts';
import { canonicalJson } from './proposals.ts';

/** The most bytes of memory a segment opens with (6 KB). An owner's choice. */
export const MEMORY_MAX_BYTES = 6 * 1024;

/** The most characters of one stored string the memory carries. An owner's choice. */
export const MEMORY_TEXT_MAX = 300;

export type MemorySection = keyof MemorySnapshot['profile'] | keyof MemorySnapshot['records'];

/**
 * What the cap keeps longest, first to last: it cuts from the last section first. Pain reports
 * come right after injuries, so recent pain outlasts everything but goals, the program and
 * injuries. An owner's choice.
 */
export const MEMORY_SECTION_PRIORITY = [
	'goals',
	'program',
	'injuries',
	'painReports',
	'avoid',
	'preferences',
	'proposals',
	'decisions',
	'recentDays',
	'trends',
	'baselines',
	'equipment',
	'recoveryNotes',
	'reviews',
	'threadSummaries',
	'analyses'
] as const satisfies readonly MemorySection[];

// Every section has a priority: a new one fails to compile until it is placed.
const _complete: [Exclude<MemorySection, (typeof MEMORY_SECTION_PRIORITY)[number]>] extends [never]
	? true
	: never = true;
void _complete;

/** Fields whose strings the server writes (dates, vocabulary, source ids): never wrapped. */
const STRUCTURAL = new Set(
	'asOf date targetDate decidedOn status stance origin kind direction severity scope decider unit type id workoutId phase decisionState'.split(
		' '
	)
);

/** `value` as data: every stored string wrapped, everything else as it is. */
function asData(value: unknown, key?: string): unknown {
	if (typeof value === 'string')
		return key !== undefined && STRUCTURAL.has(key) ? value : untrusted(value, MEMORY_TEXT_MAX);
	if (Array.isArray(value)) return value.map((item) => asData(item));
	if (value && typeof value === 'object')
		return Object.fromEntries(
			Object.entries(value).map(([field, child]) => [field, asData(child, field)])
		);
	return value;
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;

type Sections = Record<string, unknown>;

export interface MemoryData {
	asOf: string;
	profile: Sections;
	records: Sections;
	/** How many items the cap cut from each section; empty when nothing was cut. */
	omitted: Partial<Record<MemorySection, number>>;
}

/** The snapshot as the preamble carries it: wrapped, canonical once serialised, and capped. */
export function memoryData(snapshot: MemorySnapshot): MemoryData {
	const wrapped = asData(snapshot) as { asOf: string; profile: Sections; records: Sections };
	const data: MemoryData = { ...wrapped, omitted: {} };
	// The size without `omitted`'s braces, kept as items go, so cutting stays linear.
	let size = byteLength(canonicalJson(data)) - 2;
	const fits = () => size + byteLength(canonicalJson(data.omitted)) <= MEMORY_MAX_BYTES;
	for (const section of [...MEMORY_SECTION_PRIORITY].reverse()) {
		const holder = section in data.profile ? data.profile : data.records;
		while (!fits()) {
			const value = holder[section];
			if (Array.isArray(value) && value.length > 0) {
				// The item, and the comma before it unless it was the only one.
				size -= byteLength(canonicalJson(value.pop())) + (value.length > 0 ? 1 : 0);
			} else if (value !== null && value !== undefined && !Array.isArray(value)) {
				size -= byteLength(canonicalJson(value)) - 'null'.length;
				holder[section] = null;
			} else break;
			data.omitted[section] = (data.omitted[section] ?? 0) + 1;
		}
	}
	return data;
}

/** The memory's bytes: canonical JSON of memoryData, at most MEMORY_MAX_BYTES. */
export function serializeMemory(snapshot: MemorySnapshot): string {
	return canonicalJson(memoryData(snapshot));
}
