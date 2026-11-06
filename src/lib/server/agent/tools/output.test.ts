import { describe, expect, it } from 'vitest';
import * as z from 'zod/mini';
import { METHOD_MAX } from '../../../domain/coach/answer.ts';
import type { SourceRef } from '../../../domain/coach/sources.ts';
import {
	capOutput,
	fact,
	factSchema,
	metric,
	metricSchema,
	page,
	PAGE_MAX,
	pageSchema,
	sourceRefSchema,
	ToolError,
	toolError,
	untrusted,
	UNTRUSTED_MAX,
	untrustedSchema
} from './output.ts';
import { toStrictJsonSchema } from './schema.ts';

const workout: SourceRef = { type: 'workout', id: 'w-1', date: '2026-11-02', label: 'Mon squat' };
const set: SourceRef = { type: 'set', id: 's-1', workoutId: 'w-1' };
const bytes = (text: string) => new TextEncoder().encode(text).length;

describe('facts and metrics', () => {
	it('carry the records they come from', () => {
		expect(fact(140, workout, set)).toEqual({ value: 140, sources: [workout, set] });
		expect(
			metric({ value: 1.12, unit: null, method: 'EWMA ACWR, 7:28 days', sources: [workout] })
		).toEqual({ value: 1.12, unit: null, method: 'EWMA ACWR, 7:28 days', sources: [workout] });
	});

	it('refuse a metric with no method, no source or no finite value', () => {
		const ok = { value: 1, unit: 'kg', method: 'Sum of sets', sources: [workout] };
		expect(() => metric({ ...ok, method: ' ' })).toThrow(RangeError);
		expect(() => metric({ ...ok, method: 'x'.repeat(METHOD_MAX + 1) })).toThrow(RangeError);
		expect(() => metric({ ...ok, sources: [] })).toThrow(RangeError);
		expect(() => metric({ ...ok, value: Number.NaN })).toThrow(RangeError);
		expect(() => metric({ ...ok, value: Infinity })).toThrow(RangeError);
	});

	it('match the output schemas the tools declare', () => {
		expect(z.parse(factSchema(z.number()), fact(140, workout))).toEqual(fact(140, workout));
		const m = metric({ value: 3, unit: 'sessions', method: 'Count', sources: [set] });
		expect(z.parse(metricSchema, m)).toEqual(m);
		expect(() => z.parse(sourceRefSchema, { type: 'weather', id: 'x' })).toThrow();
		for (const schema of [
			factSchema(z.string()),
			metricSchema,
			pageSchema(z.string()),
			untrustedSchema
		])
			expect(() => toStrictJsonSchema(schema, 'output')).not.toThrow();
	});
});

describe('page', () => {
	const items = Array.from({ length: 25 }, (_, i) => ({ id: `w-${i + 1}` }));

	it('returns at most 20 items and says whether more exist, with a cursor to them', () => {
		const first = page(items, { cursor: (last) => last.id });
		expect(first.items).toEqual(items.slice(0, PAGE_MAX));
		expect(first).toMatchObject({ more: true, next: 'w-20' });
		expect(page(items, { limit: 5 })).toEqual({ items: items.slice(0, 5), more: true, next: null });
		expect(page(items.slice(0, 3), { limit: 5, cursor: (last) => last.id })).toEqual({
			items: items.slice(0, 3),
			more: false,
			next: null
		});
	});

	it('never exceeds the cap, whatever limit it is asked for', () => {
		expect(page(items, { limit: 500 }).items).toHaveLength(PAGE_MAX);
		expect(page(items, { limit: 0 }).items).toHaveLength(1);
		expect(z.parse(pageSchema(z.object({ id: z.string() })), page(items))).toEqual(page(items));
	});
});

describe('untrusted', () => {
	it('labels stored free text as data, without hidden controls, capped', () => {
		expect(untrusted('Felt ‮heavy\r\ntoday')).toEqual({ untrusted_text: 'Felt heavy\ntoday' });
		const long = untrusted('a'.repeat(UNTRUSTED_MAX + 5));
		expect(long).toEqual({ untrusted_text: 'a'.repeat(UNTRUSTED_MAX), truncated: true });
		expect(z.parse(untrustedSchema, long)).toEqual(long);
	});
});

describe('capOutput', () => {
	const big = (i: number) => ({ id: `w-${i}`, note: untrusted(`set ${i} `.repeat(70)) });

	it('returns canonical JSON: the same bytes whatever order the keys were built in', () => {
		const a = capOutput({ b: 1, a: { d: [1, 2], c: null }, skipped: undefined });
		expect(a).toEqual({
			value: { b: 1, a: { d: [1, 2], c: null }, skipped: undefined },
			json: '{"a":{"c":null,"d":[1,2]},"b":1}',
			truncated: false
		});
		expect(capOutput({ a: { c: null, d: [1, 2] }, b: 1 }).json).toBe(a.json);
		expect(() => capOutput({ at: new Date(0) })).toThrow(TypeError);
	});

	it('drops trailing items until the output fits in 8 KB, and says so', () => {
		const full = page(Array.from({ length: 20 }, (_, i) => big(i)));
		expect(bytes(JSON.stringify(full))).toBeGreaterThan(8 * 1024);
		const capped = capOutput(full);
		const value = capped.value as typeof full & { truncated: true };
		expect(capped.truncated).toBe(true);
		expect(bytes(capped.json)).toBeLessThanOrEqual(8 * 1024);
		expect(JSON.parse(capped.json)).toEqual(value);
		expect(value).toMatchObject({ truncated: true, more: true });
		expect(value.items).toEqual(full.items.slice(0, value.items.length));
		const oneMore = { ...value, items: full.items.slice(0, value.items.length + 1) };
		expect(bytes(capOutput(oneMore, Infinity).json)).toBeGreaterThan(8 * 1024);
	});

	it('counts bytes, not characters', () => {
		const accented = { items: Array.from({ length: 10 }, () => 'é'.repeat(100)) };
		expect(JSON.stringify(accented).length).toBeLessThan(1_100);
		const capped = capOutput(accented, 1_100);
		expect(capped.truncated).toBe(true);
		expect(bytes(capped.json)).toBeLessThanOrEqual(1_100);
	});

	it('shortens the largest list first and keeps every list a prefix of its own', () => {
		const value = { small: [1, 2, 3], large: Array.from({ length: 30 }, (_, i) => `item ${i}`) };
		const capped = capOutput(value, 200).value as typeof value;
		expect(capped.small).toEqual([1, 2, 3]);
		expect(capped.large).toEqual(value.large.slice(0, capped.large.length));
		expect(capped.large.length).toBeGreaterThan(0);
	});

	it('refuses an output it cannot shorten', () => {
		expect(() => capOutput({ text: 'x'.repeat(9_000) })).toThrow(ToolError);
		expect(() => capOutput({ text: 'x'.repeat(9_000) })).toThrow(
			expect.objectContaining({ code: 'TOO_LARGE' })
		);
	});
});

describe('toolError', () => {
	it('names what went wrong with a code the model can act on', () => {
		const error = toolError('AMBIGUOUS', 'Two exercises match', { candidates: ['a', 'b'] });
		expect(error).toBeInstanceOf(ToolError);
		expect(error).toMatchObject({
			code: 'AMBIGUOUS',
			message: 'Two exercises match',
			details: { candidates: ['a', 'b'] }
		});
		expect(() => toolError('not found', 'x')).toThrow(/code/);
	});
});
