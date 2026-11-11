/**
 * How a conversation that made a proposal says things once (Thread.svelte). The card already
 * says what changes, why, and that nothing changes until Accept, so the answer before it keeps
 * only what the card does not say:
 * - a plain recommendation (no sources, no calculation, checked) is the card's pitch: dropped;
 * - a plain note ('Noted that you dislike …') becomes a footnote under the card;
 * - every other block stays as it is: facts, numbers, safety, and any block with sources or
 *   'Not checked against your data'.
 * The conversation is titled by its outcome: its newest proposal's title.
 */
import type { CompletedBlock } from '#lib/domain/coach/index.ts';
import type { ShownMessage } from './words.ts';

/** An answer that made a proposal, as the thread shows it. */
export interface ProposalAnswer {
	/** The blocks shown as the answer. */
	blocks: CompletedBlock[];
	/** The notes shown as footnotes under its last card. */
	footnotes: CompletedBlock[];
}

const plain = (block: CompletedBlock) =>
	block.grounded && block.sources.length === 0 && block.method === null;

/** Split an answer that made a proposal into what it shows and its footnotes. */
export function proposalAnswer(blocks: readonly CompletedBlock[]): ProposalAnswer {
	const folded = (block: CompletedBlock) =>
		plain(block) && (block.kind === 'note' || block.kind === 'recommendation');
	return {
		blocks: blocks.filter((block) => !folded(block)),
		footnotes: blocks.filter((block) => plain(block) && block.kind === 'note')
	};
}

/** The stored messages' answers that made proposals, and where each one's footnotes go. */
export interface ProposalRuns {
	/** By answer id: the blocks it shows. */
	answers: Map<string, CompletedBlock[]>;
	/** By proposal id: the footnotes under it, on the last card after its answer. */
	footnotes: Map<string, CompletedBlock[]>;
}

/** A proposal is stored after the answer of the run that made it, so its answer is just before. */
export function proposalRuns(messages: readonly ShownMessage[]): ProposalRuns {
	const answers = new Map<string, CompletedBlock[]>();
	const footnotes = new Map<string, CompletedBlock[]>();
	messages.forEach((message, at) => {
		if (message.from !== 'coach' || messages[at + 1]?.from !== 'proposal') return;
		let last = at + 1;
		while (messages[last + 1]?.from === 'proposal') last++;
		const shown = proposalAnswer(message.blocks);
		answers.set(message.id, shown.blocks);
		if (shown.footnotes.length) footnotes.set(messages[last]!.id, shown.footnotes);
	});
	return { answers, footnotes };
}

/** The conversation's title: its newest proposal's, else the one it was given. */
export function outcomeTitle(title: string, proposalTitles: readonly string[]): string {
	return proposalTitles.at(-1) ?? title;
}
