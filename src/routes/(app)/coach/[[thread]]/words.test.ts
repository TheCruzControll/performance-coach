import { describe, expect, it } from 'vitest';
import type { CompletedBlock } from '#lib/domain/coach/index.ts';
import { COMPOSER_MAX_CHARS } from '#lib/ui/coach/composer-keys.ts';
import { prefillOf, shownMessages, whenWords, type DisplayedRow } from './words';

const search = (query: string) => new URLSearchParams(query);

describe('prefillOf', () => {
	it('is nothing without a question, or with a blank one', () => {
		expect(prefillOf(search(''))).toBeNull();
		expect(prefillOf(search('ask=%20%20&from=workout'))).toBeNull();
	});

	it('takes the trimmed question, and the chip of an entry it knows', () => {
		expect(prefillOf(search('ask=%20How%20did%20it%20go%3F%20&from=workout'))).toEqual({
			text: 'How did it go?',
			from: 'workout',
			label: 'From your workout'
		});
		expect(prefillOf(search('ask=Next%20week%3F&from=today'))?.label).toBe('From Today');
	});

	it('keeps an unknown entry with no chip, and drops a malformed one', () => {
		expect(prefillOf(search('ask=Hi&from=calendar'))).toEqual({
			text: 'Hi',
			from: 'calendar',
			label: null
		});
		expect(prefillOf(search('ask=Hi&from=Workout%2F1'))).toEqual({
			text: 'Hi',
			from: null,
			label: null
		});
		// Inherited keys are not entries.
		expect(prefillOf(search('ask=Hi&from=constructor'))?.label).toBeNull();
	});

	it('cuts the question at the composer’s limit, in characters', () => {
		const long = '💪'.repeat(COMPOSER_MAX_CHARS + 5);
		const text = prefillOf(search(`ask=${encodeURIComponent(long)}`))!.text;
		expect(Array.from(text)).toHaveLength(COMPOSER_MAX_CHARS);
	});
});

describe('whenWords', () => {
	// 09:30 on Wednesday 11 November 2026 in Sydney (UTC+11).
	const now = new Date('2026-11-10T22:30:00Z');
	const zone = 'Australia/Sydney';

	it('says today and yesterday with the owner’s local time', () => {
		expect(whenWords(new Date('2026-11-10T20:05:00Z'), now, zone)).toBe('Today · 07:05');
		expect(whenWords(new Date('2026-11-10T07:40:00Z'), now, zone)).toBe('Yesterday · 18:40');
	});

	it('gives an older day its short date, in the owner’s zone rather than UTC', () => {
		// 23:00 UTC on 8 November is already Monday 9 November in Sydney.
		expect(whenWords(new Date('2026-11-08T23:00:00Z'), now, zone)).toBe('Mon 9 Nov');
	});
});

describe('shownMessages', () => {
	const block = (n: number): CompletedBlock => ({
		block: n,
		kind: 'note',
		method: null,
		ast: [{ type: 'text', text: `Block ${n}` }] as CompletedBlock['ast'],
		sources: [],
		grounded: true
	});
	const row = (over: Partial<DisplayedRow>): DisplayedRow => ({
		id: crypto.randomUUID(),
		kind: 'assistant',
		status: 'complete',
		display: null,
		...over
	});

	it('shows the owner’s words and the coach’s blocks, in order', () => {
		const ask = row({ kind: 'owner_message', display: { text: 'How is my bench?' } });
		const answer = row({ display: { blocks: [block(0), block(1)] } });
		expect(shownMessages([ask, answer])).toEqual([
			{ id: ask.id, from: 'owner', text: 'How is my bench?' },
			{ id: answer.id, from: 'coach', blocks: [block(0), block(1)], ended: null }
		]);
	});

	it('marks an answer that did not complete with how it ended', () => {
		const partial = row({
			kind: 'display_only',
			status: 'stopped',
			display: { blocks: [block(0)] }
		});
		expect(shownMessages([partial])).toEqual([
			{ id: partial.id, from: 'coach', blocks: [block(0)], ended: 'Stopped' }
		]);
	});

	it('leaves out what has nothing to show', () => {
		expect(
			shownMessages([
				row({ display: null }),
				row({ display: { blocks: [] } }),
				row({ kind: 'display_only', status: 'interrupted', display: { blocks: 'oops' } }),
				row({ kind: 'owner_message', display: { text: 42 } }),
				row({ kind: 'context', display: { text: 'never shown' } })
			])
		).toEqual([]);
	});
});
