import { describe, expect, it } from 'vitest';
import { REJECT_REASON_MAX } from '../../../domain/coach/cards.ts';
import { DECISION_NOTE_MAX } from '../../db/schema/coaching.ts';

describe('a rejection’s reason', () => {
	it('is bounded on the card’s sheet exactly as coach_proposals.decision_note stores it', () => {
		expect(REJECT_REASON_MAX).toBe(DECISION_NOTE_MAX);
	});
});
