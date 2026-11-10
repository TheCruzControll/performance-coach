import { describe, expect, it } from 'vitest';
import type { CompletedBlock } from '#lib/domain/coach/index.ts';
import { COMPOSER_MAX_CHARS } from '#lib/ui/coach/composer-keys.ts';
import type { ProposalCardView } from '#lib/domain/coach/cards.ts';
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
			{ id: ask.id, from: 'owner', text: 'How is my bench?', clientId: null },
			{
				id: answer.id,
				from: 'coach',
				blocks: [block(0), block(1)],
				ended: null,
				retryable: false
			}
		]);
	});

	it('keeps the id the owner’s message was sent with, for Retry', () => {
		const clientMessageId = crypto.randomUUID();
		const ask = row({ kind: 'owner_message', display: { text: 'Again?' }, clientMessageId });
		expect(shownMessages([ask])).toEqual([
			{ id: ask.id, from: 'owner', text: 'Again?', clientId: clientMessageId }
		]);
	});

	it('offers Retry for an interrupted or failed answer, not a stopped or complete one', () => {
		const partial = (status: DisplayedRow['status']) =>
			row({ kind: 'display_only', status, display: { blocks: [block(0)] } });
		const shown = shownMessages(
			(['interrupted', 'failed', 'stopped'] as const)
				.map(partial)
				.concat(row({ display: { blocks: [block(0)] } }))
		);
		expect(shown.map((m) => m.from === 'coach' && [m.ended, m.retryable])).toEqual([
			['Interrupted', true],
			['Failed', true],
			['Stopped', false],
			[null, false]
		]);
	});

	it('marks an answer that did not complete with how it ended', () => {
		const partial = row({
			kind: 'display_only',
			status: 'stopped',
			display: { blocks: [block(0)] }
		});
		expect(shownMessages([partial])).toEqual([
			{ id: partial.id, from: 'coach', blocks: [block(0)], ended: 'Stopped', retryable: false }
		]);
	});

	it('leaves out what has nothing to show', () => {
		expect(
			shownMessages([
				row({ display: null }),
				row({ display: { blocks: [] } }),
				row({ kind: 'display_only', status: 'interrupted', display: { blocks: 'oops' } }),
				row({ kind: 'owner_message', display: { text: 42 } }),
				row({ kind: 'context', display: { text: 'never shown', blocks: [block(0)] } }),
				row({ kind: 'tool_results', display: { blocks: [block(1)] } })
			])
		).toEqual([]);
	});

	describe('with proposal cards', () => {
		const card = (id: string): ProposalCardView => ({
			id,
			kind: 'program_adjustment',
			status: 'proposed',
			title: `Proposal ${id}`,
			rationale: 'Why',
			rows: [],
			impactLines: [],
			warnings: [],
			appliedVersion: null,
			supersededReason: null
		});
		const RUN_1 = '00000000-0000-4000-8000-000000000001';
		const RUN_2 = '00000000-0000-4000-8000-000000000002';

		it('puts each card after the last row of the run that proposed it', () => {
			const ask1 = row({ kind: 'owner_message', display: { text: 'Move it' }, runId: null });
			const tools = row({ kind: 'assistant', display: null, runId: RUN_1 });
			const answer1 = row({ display: { blocks: [block(0)] }, runId: RUN_1 });
			const ask2 = row({ kind: 'owner_message', display: { text: 'And this' }, runId: null });
			const answer2 = row({ display: { blocks: [block(1)] }, runId: RUN_2 });
			const shown = shownMessages(
				[ask1, tools, answer1, ask2, answer2],
				[
					{ runId: RUN_2, card: card('c') },
					{ runId: RUN_1, card: card('a') },
					{ runId: RUN_1, card: card('b') }
				]
			);
			expect(shown.map((m) => (m.from === 'proposal' ? m.card.id : m.id))).toEqual([
				ask1.id,
				answer1.id,
				'a',
				'b',
				ask2.id,
				answer2.id,
				'c'
			]);
			expect(shown[2]).toEqual({ id: 'a', from: 'proposal', card: card('a') });
		});

		it('keeps a card whose run shows no answer, after that run’s last row', () => {
			const ask = row({ kind: 'owner_message', display: { text: 'Move it' } });
			const tools = row({ kind: 'tool_results', display: null, runId: RUN_1 });
			expect(
				shownMessages([ask, tools], [{ runId: RUN_1, card: card('a') }]).map((m) => m.id)
			).toEqual([ask.id, 'a']);
		});

		it('leaves out a card whose run is not on this page', () => {
			const answer = row({ display: { blocks: [block(0)] }, runId: RUN_1 });
			expect(shownMessages([answer], [{ runId: RUN_2, card: card('x') }]).map((m) => m.id)).toEqual(
				[answer.id]
			);
		});
	});
});
