/**
 * A stale re-plan's card as the server renders it: Propose again beside its reason, and each
 * state in place (busy, the engine's note, Couldn’t prepare it with Try again, offline). The words
 * come from domain/coach/propose-again.ts; a card without the action, or a proposal that is not a
 * stale re-plan, offers none.
 */
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { ProposalCardView } from '#lib/domain/coach/cards.ts';
import {
	COULDNT_PREPARE,
	NOT_REPROPOSABLE_NOTE,
	PROPOSE_AGAIN_FAILED,
	PROPOSE_AGAIN_OFFLINE,
	type ProposeAgainOutcome
} from '#lib/domain/coach/propose-again.ts';
import ProposalCard from './ProposalCard.svelte';

const stale = (over: Partial<ProposalCardView> = {}): ProposalCardView => ({
	id: '9b2f4d4e-5f0a-4d47-9a43-0c1d2b3a4e5f',
	kind: 'replan',
	status: 'superseded',
	title: 'Re-plan for your new priorities',
	rationale: 'Your goals changed.',
	rows: [],
	impactLines: [],
	warnings: [],
	appliedVersion: null,
	supersededReason: 'profile_changed',
	proposeAgain: true,
	...over
});

type Props = {
	card?: ProposalCardView;
	onproposeagain?: () => void;
	proposing?: boolean;
	proposeOutcome?: ProposeAgainOutcome | null;
	offline?: boolean;
};

const html = (props: Props = {}) =>
	render(ProposalCard, { props: { card: stale(), ...props } }).body;

/** The opening tag of the element with this test id. */
const tagOf = (markup: string, testId: string) =>
	markup.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? '';

/** The card's one status line: the only live region an answer is announced through. */
const statusOf = (markup: string) =>
	markup.match(/<p class="visually-hidden" role="status">([\s\S]*?)<\/p>/)?.[1] ?? '';

describe('Propose again on a stale re-plan', () => {
	it('is offered beside the reason, with its handler', () => {
		const markup = html({ onproposeagain: () => {} });
		expect(markup).toContain('data-testid="proposal-again"');
		expect(tagOf(markup, 'proposal-propose-again')).not.toContain('disabled');
		expect(markup).toContain('Propose again');
		expect(markup).toContain('Your profile changed since');
		expect(markup).not.toContain('aria-busy="true"');
	});

	it('is not offered without a handler, nor for a proposal that is not a stale re-plan', () => {
		expect(html()).not.toContain('data-testid="proposal-again"');
		const fresh = html({ card: stale({ proposeAgain: undefined }), onproposeagain: () => {} });
		expect(fresh).not.toContain('data-testid="proposal-again"');
	});

	it('is busy while it runs, and its button cannot be sent again', () => {
		const markup = html({ onproposeagain: () => {}, proposing: true });
		expect(markup).toContain('aria-busy="true" data-testid="proposal-again"');
		expect(tagOf(markup, 'proposal-propose-again')).toContain('disabled');
	});

	it('answers a refusal with the engine’s sentence on a neutral line, and no failure', () => {
		const why = 'Nothing in that week is still ahead of you, so there is nothing left to change.';
		const markup = html({ onproposeagain: () => {}, proposeOutcome: { status: 'refused', why } });
		expect(markup).toContain(why);
		expect(markup).toContain('data-testid="proposal-propose-note"');
		expect(markup).not.toContain(COULDNT_PREPARE);
		expect(markup).not.toContain('data-testid="proposal-propose-failure"');
	});

	it('answers a failure with Couldn’t prepare it and Try again', () => {
		const markup = html({ onproposeagain: () => {}, proposeOutcome: { status: 'failed' } });
		expect(markup).toContain(COULDNT_PREPARE);
		expect(markup).toContain(PROPOSE_AGAIN_FAILED);
		expect(markup).toContain('data-testid="proposal-propose-retry"');
		expect(markup).toContain('Try again');
		expect(markup).not.toContain('Retry');
	});

	it('hides the main Propose again button while the failure shows: Try again is the only one', () => {
		const markup = html({ onproposeagain: () => {}, proposeOutcome: { status: 'failed' } });
		expect(markup).toContain('data-testid="proposal-propose-retry"');
		expect(markup).not.toContain('data-testid="proposal-propose-again"');
		// Once it is no longer a failure (the answer is a note), the main button is back.
		const noted = html({
			onproposeagain: () => {},
			proposeOutcome: { status: 'unchanged' }
		});
		expect(noted).toContain('data-testid="proposal-propose-again"');
	});

	it('says the note in the card’s status line, not in a live region of its own', () => {
		const why = 'Nothing in that week is still ahead of you, so there is nothing left to change.';
		const markup = html({ onproposeagain: () => {}, proposeOutcome: { status: 'refused', why } });
		expect(tagOf(markup, 'proposal-propose-note')).not.toContain('role="status"');
		expect(tagOf(markup, 'proposal-propose-note')).toContain('tabindex="-1"');
		expect(statusOf(markup)).toContain(why);
		// Only the one live region in the card.
		expect(markup.match(/role="status"/g)).toHaveLength(1);
	});

	it('keeps the status line on the card’s own words while no answer has come', () => {
		const markup = html({ onproposeagain: () => {} });
		expect(statusOf(markup)).toContain(
			'Re-plan for your new priorities: Your profile changed since'
		);
	});

	it('shows the status line busy while it runs, and no note', () => {
		const markup = html({
			onproposeagain: () => {},
			proposing: true,
			proposeOutcome: { status: 'unchanged' }
		});
		expect(statusOf(markup)).toBe('Preparing it again…');
		expect(markup).not.toContain('data-testid="proposal-propose-note"');
	});

	it('answers a source that cannot be asked again with a neutral note, and no failure', () => {
		const markup = html({
			onproposeagain: () => {},
			proposeOutcome: { status: 'not_reproposable' }
		});
		expect(markup).toContain(NOT_REPROPOSABLE_NOTE);
		expect(statusOf(markup)).toContain(NOT_REPROPOSABLE_NOTE);
		expect(markup).not.toContain(COULDNT_PREPARE);
		expect(markup).not.toContain('data-testid="proposal-propose-failure"');
		expect(markup).toContain('data-testid="proposal-propose-again"');
	});

	it('is disabled offline, with the reason', () => {
		const markup = html({ onproposeagain: () => {}, offline: true });
		expect(markup).toContain('data-testid="proposal-propose-offline"');
		expect(markup).toContain(PROPOSE_AGAIN_OFFLINE);
		expect(tagOf(markup, 'proposal-propose-again')).toContain('disabled');
	});
});

describe('a re-plan’s own lines', () => {
	it('shows the capped line under its rows, and a deload its line before its impact', () => {
		const markup = html({
			card: stale({
				supersededReason: null,
				status: 'proposed',
				proposeAgain: undefined,
				moreRows: '3 more changes not listed',
				deloadLine: 'Week of 23 Nov becomes a deload week'
			})
		});
		expect(markup).toContain('data-testid="proposal-more"');
		expect(markup).toContain('3 more changes not listed');
		expect(markup).toContain('data-testid="proposal-deload"');
		expect(markup).toContain('Week of 23 Nov becomes a deload week');
		// A deload's impact is its own line, not the 'stay as they are' sentence.
		expect(markup).not.toContain('stay as they are');
	});
});
