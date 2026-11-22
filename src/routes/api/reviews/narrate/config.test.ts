/**
 * POST /api/reviews/narrate runs one coach turn, so Vercel must let it run as long as
 * /api/coach/turns: COACH_MAX_DURATION_S, which every turn limit derives from (domain/coach/budgets.ts).
 */
import { describe, expect, it } from 'vitest';
import { COACH_MAX_DURATION_S, TURN_LIMITS } from '#lib/domain/coach/budgets.ts';
import { config } from './+server';

describe('the write-up endpoint', () => {
	it('may run COACH_MAX_DURATION_S on Vercel, and a turn stops before that', () => {
		expect(config.maxDuration).toBe(COACH_MAX_DURATION_S);
		expect(TURN_LIMITS.turnMs).toBeLessThan(COACH_MAX_DURATION_S * 1000);
	});
});
