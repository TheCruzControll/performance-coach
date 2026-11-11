/**
 * A conversation that made a proposal says things once (proposal-thread.ts): the answer's plain
 * recommendation is left out when its cards are program adjustments, its plain notes go under the
 * last card as footnotes, anything with sources, a calculation or 'Not checked' stays, and the
 * conversation takes its newest proposal's title that was not declined. Thread.svelte draws it; render.test.ts checks the markup.
 */
import { describe, expect, it } from 'vitest';
import type { ProposalCardView } from '#lib/domain/coach/cards.ts';
import type { AnswerBlockKind, CompletedBlock } from '#lib/domain/coach/index.ts';
import { outcomeTitle, proposalAnswer, proposalRuns } from './proposal-thread.ts';
import type { ShownMessage } from './words.ts';

let next = 0;
function block(kind: AnswerBlockKind, text: string, extra: Partial<CompletedBlock> = {}) {
	return {
		block: next++,
		kind,
		method: null,
		ast: [{ type: 'paragraph', children: [{ type: 'text', text }] }],
		sources: [],
		grounded: true,
		...extra
	} satisfies CompletedBlock;
}

const card = (id: string, title: string, kind = 'program_adjustment'): ProposalCardView => ({
	id,
	kind,
	status: 'proposed',
	title,
	rationale: 'You said you dislike it.',
	rows: [],
	impactLines: [],
	warnings: [],
	appliedVersion: null,
	supersededReason: null
});

const note = block('note', 'Noted that you dislike Bulgarian split squats.');
const pitch = block(
	'recommendation',
	'I’ve drafted that change; nothing changes until you accept.'
);
const fact = block('fact', 'You did 3 sets on Monday.');
const safety = block('safety', 'Stop if it hurts.');

const ADJUSTMENT = ['program_adjustment'];

describe('proposalAnswer', () => {
	it('leaves out the plain recommendation and makes the plain note a footnote', () => {
		expect(proposalAnswer([note, pitch], ADJUSTMENT)).toEqual({ blocks: [], footnotes: [note] });
	});

	it('keeps facts, numbers and safety as the answer, in order', () => {
		const metric = block('metric', 'e1RM 112.5 kg', { method: 'Epley' });
		expect(proposalAnswer([fact, note, metric, pitch, safety], ADJUSTMENT)).toEqual({
			blocks: [fact, metric, safety],
			footnotes: [note]
		});
	});

	it('keeps the pitch of a card that does not say it: a next cycle, a swap for one session', () => {
		const nextCycle = block(
			'recommendation',
			'I’ve drafted your next cycle. Accepting it keeps it ready for your cycle review; your current program doesn’t change.'
		);
		expect(proposalAnswer([nextCycle], ['next_cycle'])).toEqual({
			blocks: [nextCycle],
			footnotes: []
		});
		expect(proposalAnswer([note, pitch], ['program_adjustment', 'session_substitution'])).toEqual({
			blocks: [pitch],
			footnotes: [note]
		});
	});

	it('keeps a recommendation or note that has sources or was not checked', () => {
		const sourced = block('recommendation', 'Swap it for lunges.', {
			sources: [{ type: 'exercise', id: 'e1' }]
		});
		const unchecked = block('note', 'You squatted 140 kg.', { grounded: false });
		expect(proposalAnswer([sourced, unchecked], ADJUSTMENT)).toEqual({
			blocks: [sourced, unchecked],
			footnotes: []
		});
	});
});

describe('proposalRuns', () => {
	const owner: ShownMessage = { id: 'o1', from: 'owner', text: 'Replace them', clientId: null };
	const answer: ShownMessage = {
		id: 'a1',
		from: 'coach',
		blocks: [note, pitch, fact],
		ended: null,
		retryable: false
	};

	it('shows an answer before cards without its pitch, its note under the last card', () => {
		const runs = proposalRuns([
			owner,
			answer,
			{ id: 'p1', from: 'proposal', card: card('p1', 'Replace Bulgarian split squat') },
			{ id: 'p2', from: 'proposal', card: card('p2', 'Move intervals') }
		]);
		expect(runs.answers).toEqual(new Map([['a1', [fact]]]));
		expect(runs.footnotes).toEqual(new Map([['p2', [note]]]));
	});

	it('keeps a next cycle’s pitch in its answer', () => {
		const runs = proposalRuns([
			owner,
			answer,
			{ id: 'p1', from: 'proposal', card: card('p1', 'Next block', 'next_cycle') }
		]);
		expect(runs.answers).toEqual(new Map([['a1', [pitch, fact]]]));
	});

	it('leaves an answer with no card after it alone', () => {
		const later: ShownMessage = { ...answer, id: 'a2' };
		const runs = proposalRuns([
			answer,
			{ id: 'p1', from: 'proposal', card: card('p1', 'Replace') },
			owner,
			later
		]);
		expect([...runs.answers.keys()]).toEqual(['a1']);
		expect([...runs.footnotes.keys()]).toEqual(['p1']);
	});
});

describe('outcomeTitle', () => {
	const shown = (title: string, status: ProposalCardView['status'] = 'proposed') => ({
		title,
		status
	});

	it('is the newest proposal’s title, else the conversation’s', () => {
		expect(
			outcomeTitle('I hate them, replace them', [shown('Replace A'), shown('Replace A once')])
		).toBe('Replace A once');
		expect(outcomeTitle('How is my bench?', [])).toBe('How is my bench?');
	});

	it('skips a declined proposal', () => {
		expect(
			outcomeTitle('Replace them', [shown('Replace A', 'applied'), shown('Move B', 'rejected')])
		).toBe('Replace A');
		expect(outcomeTitle('Replace them', [shown('Replace A', 'rejected')])).toBe('Replace them');
	});
});
