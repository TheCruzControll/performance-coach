/**
 * What makes a program reproducible (PRD §5): the catalogue digest, the fingerprint, seeded
 * randomness and one text order. Nothing here reads a clock or Math.random.
 *
 * - catalogueDigest hashes the library's content, so a version records which library built it.
 * - fingerprint hashes the canonical input, the digest and GENERATOR_ID. The same profile and
 *   library give the same fingerprint, whatever the time zone or the order of the profile's rows,
 *   and any change that could change the program changes it.
 * - seededRandom breaks ties the same way on every run for the same seed. Seed it with stable
 *   facts, such as a slot's key.
 *
 * Hashes are FNV-1a 64-bit over UTF-8 canonical JSON, as 16 hex digits: fast, dependency-free and
 * the same in every runtime. They detect change; they are not a security boundary.
 */
import type { CatalogueExercise } from '../exercises/format.ts';
import type { CustomExercise } from '../training/types.ts';
import type { OwnedExercise, ProgrammingInput } from './input.ts';

/**
 * The generator's version, part of every fingerprint. Bump it whenever the same input and library
 * could give a different plan: a rule, a stage, a template's words.
 */
export const GENERATOR_ID = 'perfo-programming/6';

/** Code-unit order: the same on every machine and in every locale, unlike localeCompare. */
export const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** FNV-1a 64-bit, as its two 32-bit halves: ×(2^40 + 0x1b3) mod 2^64, split by hand. */
function fnv1a(text: string): [hi: number, lo: number] {
	let hi = 0xcbf29ce4;
	let lo = 0x84222325;
	for (const byte of new TextEncoder().encode(text)) {
		lo = (lo ^ byte) >>> 0;
		const low = lo * 0x1b3;
		hi = (Math.imul(hi, 0x1b3) + Math.floor(low / 2 ** 32) + (lo << 8)) >>> 0;
		lo = low >>> 0;
	}
	return [hi, lo];
}

export function fnv1a64(text: string): string {
	return fnv1a(text)
		.map((half) => half.toString(16).padStart(8, '0'))
		.join('');
}

/**
 * Plain data as JSON with every object's keys in code-unit order, so key order never changes a
 * hash. Anything else (a Date, a Map, a function, NaN) throws rather than hash as `{}` or null.
 */
export function canonicalJson(value: unknown): string {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') {
		return JSON.stringify(value);
	}
	if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
	if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
		const fields = Object.entries(value)
			.filter(([, field]) => field !== undefined)
			.sort(([a], [b]) => compareText(a, b))
			.map(([key, field]) => `${JSON.stringify(key)}:${canonicalJson(field)}`);
		return `{${fields.join(',')}}`;
	}
	throw new TypeError(`Not plain data: ${String(value)}`);
}

/** Every field of an exercise's content; the compile-time check below keeps the list complete. */
const CONTENT = [
	'name',
	'aliases',
	'pattern',
	'primaryMuscles',
	'secondaryMuscles',
	'equipment',
	'substitutionGroup',
	'skillLevel',
	'repMin',
	'repMax',
	'defaultSeconds',
	'unilateral',
	'measure',
	'loadType',
	'tags',
	'disciplines'
] as const satisfies readonly (keyof CustomExercise)[];
const _complete: [Exclude<keyof CustomExercise, (typeof CONTENT)[number]>] extends [never]
	? true
	: false = true;

/** An exercise's content alone, without the ids, timestamps or retirement a row may carry. */
export function exerciseContent(exercise: CustomExercise): CustomExercise {
	return Object.fromEntries(
		CONTENT.map((field) => [field, exercise[field]])
	) as unknown as CustomExercise;
}

/** The library's content, in key order: the catalogue entries and the owner's own, by id. */
export function catalogueDigest(
	catalogue: readonly CatalogueExercise[],
	customExercises: readonly OwnedExercise[]
): string {
	const entries = [
		...catalogue.map((e) => ({ key: e.key, baselineLift: e.baselineLift, ...exerciseContent(e) })),
		...customExercises.map((e) => ({ key: `custom:${e.id}`, ...exerciseContent(e) }))
	].sort((a, b) => compareText(a.key, b.key));
	return fnv1a64(canonicalJson(entries));
}

/** The input without its row ids (`refs`), with the digest and the generator's version. */
export function fingerprint(
	input: ProgrammingInput,
	digest: string,
	generator: string = GENERATOR_ID
): string {
	const { refs: _refs, ...canonical } = input;
	return fnv1a64(canonicalJson({ generator, digest, input: canonical }));
}

export interface SeededRandom {
	/** The next number in [0, 1). */
	next(): number;
	/** A whole number from 0 to n − 1. */
	int(n: number): number;
	/** One of `items`; an empty list throws. */
	pick<T>(items: readonly T[]): T;
	/** A shuffled copy of `items` (Fisher–Yates). */
	shuffle<T>(items: readonly T[]): T[];
}

/** mulberry32 from `seed`: a number, or a text hashed with FNV-1a. */
export function seededRandom(seed: number | string): SeededRandom {
	let state = typeof seed === 'number' ? seed >>> 0 : fnv1a(seed)[1];
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = Math.imul(state ^ (state >>> 15), state | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
	};
	const int = (n: number) => Math.floor(next() * n);
	return {
		next,
		int,
		pick(items) {
			if (!items.length) throw new RangeError('Nothing to pick from');
			return items[int(items.length)]!;
		},
		shuffle(items) {
			const out = [...items];
			for (let i = out.length - 1; i > 0; i--) {
				const j = int(i + 1);
				[out[i], out[j]] = [out[j]!, out[i]!];
			}
			return out;
		}
	};
}
