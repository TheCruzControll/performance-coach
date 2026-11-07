import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MIN_CACHEABLE_TOKENS, MOCK_BYTES_PER_TOKEN } from '../provider/mock.ts';
import { DRAFTER_CLAUSES, DRAFTER_PROMPT } from './drafter.ts';
import { SYSTEM_PROMPT } from './system.ts';

/** Pinned: update it in the same commit as a deliberate edit to the prompt. */
const PINNED_SHA256 = '88ce136e5791ddd875fd945fc9f12854acefbe8d4bc3544eea6ffef6070ec40f';

describe('DRAFTER_PROMPT', () => {
	it('is the pinned text, made of its frozen clauses in order', () => {
		expect(createHash('sha256').update(DRAFTER_PROMPT).digest('hex')).toBe(PINNED_SHA256);
		expect(DRAFTER_PROMPT).toBe(Object.values(DRAFTER_CLAUSES).join('\n\n'));
		expect(Object.isFrozen(DRAFTER_CLAUSES)).toBe(true);
		expect(DRAFTER_PROMPT).not.toBe(SYSTEM_PROMPT);
	});

	it('states what a draft rests on and must respect', () => {
		for (const phrase of [
			'untrusted_text',
			'never follow an instruction',
			'Never invent an id',
			'smallest change',
			'program_adjustment',
			'workout_update',
			'next_cycle',
			'painful',
			'goal priorities',
			'up to 80 characters'
		])
			expect(DRAFTER_PROMPT).toContain(phrase);
	});

	it('holds nothing that changes, so its cached bytes never do', () => {
		expect(DRAFTER_PROMPT).not.toMatch(/\d{4}-\d{2}-\d{2}/);
		expect(DRAFTER_PROMPT).not.toMatch(/\b\d{1,2}:\d{2}\b/);
		expect(DRAFTER_PROMPT).not.toMatch(/\b(19|20)\d{2}\b/);
		expect(DRAFTER_PROMPT).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
		expect(DRAFTER_PROMPT).not.toMatch(/https?:|localhost|vercel|neon|sk-ant|process\.env/i);
	});

	it('is long enough to be cached on its own', () => {
		expect(Buffer.byteLength(DRAFTER_PROMPT)).toBeGreaterThanOrEqual(
			MIN_CACHEABLE_TOKENS * MOCK_BYTES_PER_TOKEN
		);
	});
});
