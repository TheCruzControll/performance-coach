/**
 * decisionOf: the decision a revision chain's head records. The chain walk itself is tested on
 * Postgres (tests/integration/reviews/store.test.ts); sessions_passed is tested here because M5's
 * CHECK accepts it only once weekly-review-service adds it to the vocabulary.
 */
import { describe, expect, it } from 'vitest';
import type { ProposalHeadRow } from '../../db/queries/reviews';
import { decisionOf, stale } from './store';

const head = (more: Partial<ProposalHeadRow>): ProposalHeadRow => ({
	id: 'p-2',
	status: 'proposed',
	supersededReason: null,
	appliedVersionId: null,
	appliedVersionNumber: null,
	depth: 1,
	...more
});

describe('decisionOf', () => {
	it('reads each head status as its decision', () => {
		expect(decisionOf(null)).toEqual({ state: 'none' });
		expect(decisionOf(head({}))).toEqual({ state: 'undecided', proposalId: 'p-2' });
		expect(decisionOf(head({ status: 'accepted' }))).toEqual({
			state: 'accepted_waiting',
			proposalId: 'p-2'
		});
		expect(decisionOf(head({ status: 'rejected' }))).toEqual({
			state: 'rejected',
			proposalId: 'p-2'
		});
		expect(
			decisionOf(head({ status: 'applied', appliedVersionId: 'v-3', appliedVersionNumber: 3 }))
		).toEqual({ state: 'applied', proposalId: 'p-2', versionId: 'v-3', versionNumber: 3 });
	});

	it('reads a head superseded as sessions_passed as partly past, and any other reason as superseded', () => {
		expect(decisionOf(head({ status: 'superseded', supersededReason: 'sessions_passed' }))).toEqual(
			{ state: 'partly_past', proposalId: 'p-2' }
		);
		expect(decisionOf(head({ status: 'superseded', supersededReason: 'revised' }))).toEqual({
			state: 'superseded',
			proposalId: 'p-2',
			reason: 'revised'
		});
	});
});

describe('stale', () => {
	it('compares the stored digest with today’s, and never calls a review without one stale', () => {
		expect(stale({ inputsDigest: 'aaaa' }, 'aaaa')).toBe(false);
		expect(stale({ inputsDigest: 'aaaa' }, 'bbbb')).toBe(true);
		expect(stale({ inputsDigest: null }, 'bbbb')).toBe(false);
	});
});
