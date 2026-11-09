/**
 * Test overrides for the mock coach: a fault every call fails with, a script that answers whatever
 * the owner asks, a delay before every chunk, a reason the coach is unavailable (agent/coach.ts
 * reports it in place of the environment's choice) and a shorter turn. Only the test route (POST
 * /api/test-support/coach, coach-test-support) sets them, and only where test routes are enabled;
 * where they are not, nothing can set them and the mock never reads them, so no production request
 * can reach them.
 */
import { testRoutesEnabled } from '../../env.ts';
import type { CoachUnavailableReason } from '../../../domain/coach/vocabulary.ts';
import type { ProviderErrorKind } from './types.ts';

export interface MockOverrides {
	readonly fault?: { readonly kind: ProviderErrorKind; readonly retryAfterMs?: number };
	/** The name of the mock script to play, whatever the owner's message. */
	readonly script?: string;
	readonly chunkDelayMs?: number;
	/** The coach is unavailable for this reason, whatever the environment chose. */
	readonly unavailable?: CoachUnavailableReason;
	/** A turn's time, in place of TURN_LIMITS.turnMs: a slow script then times out. */
	readonly turnMs?: number;
}

const NONE: MockOverrides = Object.freeze({});
let current = NONE;

/** Called by the test route; refused unless test routes are enabled. */
export function setMockOverrides(next: MockOverrides, enabled = testRoutesEnabled()): void {
	if (!enabled) throw new Error('Mock overrides are set only through the test route');
	current = Object.freeze({ ...next });
}

export function clearMockOverrides(): void {
	current = NONE;
}

/** The overrides in force: none unless some were set and test routes are still enabled. */
export function mockOverrides(enabled: () => boolean = testRoutesEnabled): MockOverrides {
	return current !== NONE && enabled() ? current : NONE;
}
