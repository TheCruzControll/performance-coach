/**
 * digest.ts: a stored review's inputs digest changes exactly when what it was computed from does:
 * an edited fact, a workout completed or abandoned, new analytics definitions. The order the facts
 * were loaded in never changes it.
 */
import { describe, expect, it } from 'vitest';
import { ANALYTICS_VERSION } from '../../analytics/version';
import { inputsDigest } from './digest';
import type { DigestFacts } from './digest';

const facts: DigestFacts = {
	facts: [
		{ kind: 'set', id: 'a1', updatedAt: '2026-11-03T18:00:00.000Z' },
		{ kind: 'set', id: 'a2', updatedAt: '2026-11-03T18:05:00.000Z' },
		{ kind: 'run', id: 'a1', updatedAt: '2026-11-05T14:00:00.000Z' },
		{ kind: 'session', id: 's1', updatedAt: '2026-10-30T09:00:00.000Z' }
	],
	workouts: [
		{ id: 'w1', status: 'completed' },
		{ id: 'w2', status: 'in_progress' }
	]
};

const withFact = (index: number, updatedAt: string): DigestFacts => ({
	...facts,
	facts: facts.facts.map((fact, i) => (i === index ? { ...fact, updatedAt } : fact))
});
const withStatus = (id: string, status: 'completed' | 'abandoned' | 'in_progress') => ({
	...facts,
	workouts: facts.workouts.map((w) => (w.id === id ? { ...w, status } : w))
});

describe('inputsDigest', () => {
	const digest = inputsDigest(facts);

	it('is 16 hex digits, the same for equal facts', () => {
		expect(digest).toMatch(/^[0-9a-f]{16}$/);
		expect(inputsDigest(structuredClone(facts))).toBe(digest);
		// A Drizzle row's Date and its ISO text are the same instant.
		const dates = {
			...facts,
			facts: facts.facts.map((fact) => ({ ...fact, updatedAt: new Date(fact.updatedAt) }))
		};
		expect(inputsDigest(dates)).toBe(digest);
	});

	it('is independent of input order', () => {
		const reversed = {
			facts: [...facts.facts].reverse(),
			workouts: [...facts.workouts].reverse()
		};
		expect(inputsDigest(reversed)).toBe(digest);
		const rotated = { ...facts, facts: [...facts.facts.slice(2), ...facts.facts.slice(0, 2)] };
		expect(inputsDigest(rotated)).toBe(digest);
	});

	it("changes when a set's updated_at changes", () => {
		expect(inputsDigest(withFact(1, '2026-11-10T07:00:00.000Z'))).not.toBe(digest);
	});

	it('changes when a fact is added or removed, and tells kinds apart', () => {
		expect(inputsDigest({ ...facts, facts: facts.facts.slice(1) })).not.toBe(digest);
		const kinds = { ...facts, facts: facts.facts.map((f) => ({ ...f, kind: 'other' })) };
		expect(inputsDigest(kinds)).not.toBe(digest);
	});

	it('changes when a workout is completed or abandoned', () => {
		const completed = inputsDigest(withStatus('w2', 'completed'));
		const abandoned = inputsDigest(withStatus('w2', 'abandoned'));
		expect(new Set([digest, completed, abandoned]).size).toBe(3);
		expect(inputsDigest(withStatus('w1', 'abandoned'))).not.toBe(digest);
	});

	it('changes with ANALYTICS_VERSION, which it uses by default', () => {
		expect(inputsDigest(facts, ANALYTICS_VERSION)).toBe(digest);
		expect(inputsDigest(facts, ANALYTICS_VERSION + 1)).not.toBe(digest);
	});

	it('refuses a timestamp that is not an instant', () => {
		expect(() => inputsDigest(withFact(0, 'yesterday'))).toThrow(RangeError);
	});
});
