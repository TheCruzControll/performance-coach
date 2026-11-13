/**
 * Why the coach cannot answer (PRD §12, §15): the wire vocabularies of the coach's availability
 * and of the errors a turn can end with. Part of the coach vocabulary (vocabulary.ts re-exports
 * them); a module of their own so the Coach screen, whose notices name them, loads only these.
 */
import { keysOf } from './labels.ts';

/**
 * Wire. Why the coach cannot run a turn. not_launched and disabled refuse every turn; no_key and
 * mock_in_production are misconfigurations that still serve direct answers (PRD §15).
 */
export const COACH_UNAVAILABLE_REASON_LABEL = {
	no_key: 'The coach has no API key',
	mock_in_production: 'The practice coach cannot run in production',
	not_launched: 'Your coach is getting ready',
	disabled: 'The coach is switched off'
};
export type CoachUnavailableReason = keyof typeof COACH_UNAVAILABLE_REASON_LABEL;
export const COACH_UNAVAILABLE_REASONS = keysOf(COACH_UNAVAILABLE_REASON_LABEL);

/** Wire. The error a turn's stream ends with; offline is the browser's own. */
export const COACH_ERROR_KIND_LABEL = {
	unavailable: 'The coach is unavailable',
	rate_limited: 'Too many questions in a short time',
	budget: 'Today’s coach budget is used up',
	refused: 'The coach can’t help with that',
	busy: 'Another answer is still running',
	timeout: 'The answer took too long',
	provider: 'The coach service had a problem',
	cancelled: 'Stopped',
	interrupted: 'The answer was interrupted',
	invalid_request: 'That message couldn’t be sent',
	not_found: 'Conversation not found',
	offline: 'You’re offline'
};
export type CoachErrorKind = keyof typeof COACH_ERROR_KIND_LABEL;
export const COACH_ERROR_KINDS = keysOf(COACH_ERROR_KIND_LABEL);
