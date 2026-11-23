/**
 * 'Propose again' on a stale re-plan (m7/50): what the action answers, and the words its card
 * shows. Client-safe and zod-free, imported by path: the server's action returns an outcome, the
 * browser posts for it (client/coach/proposals.ts) and the card shows its note.
 *
 * - proposed: a fresh proposal, the page opens it (no note).
 * - refused: the engine's own sentence, on a neutral line; no proposal is made.
 * - unchanged: the plan already has the change; nothing is made.
 * - not_stale: the proposal is not a stale re-plan any more; nothing is made.
 * - not_reproposable: the stale re-plan's source (who asked, in which conversation) cannot be
 *   read again, so nothing is made. Not a failure: Try again would give the same answer.
 * - failed: nothing was made or kept; the card says so, with Try again, which sends the same
 *   request again.
 */

export type ProposeAgainOutcome =
	| { status: 'proposed'; id: string }
	| { status: 'refused'; why: string }
	| { status: 'unchanged' }
	| { status: 'not_stale' }
	| { status: 'not_reproposable' }
	| { status: 'failed' };

export const PROPOSE_AGAIN = 'Propose again';
export const COULDNT_PREPARE = 'Couldn’t prepare it';
export const PROPOSE_AGAIN_FAILED = 'Check your connection and try again.';
export const PROPOSE_AGAIN_OFFLINE = 'You’re offline. Propose again once you’re back online.';
export const UNCHANGED_NOTE =
	'Your plan already has this change, so there is nothing new to propose.';
export const NOT_STALE_NOTE = 'This re-plan is already up to date.';
export const NOT_REPROPOSABLE_NOTE = 'This can’t be proposed again from here';

/** The neutral line an outcome leaves on the card; null when it leaves none. */
export function proposeNote(outcome: ProposeAgainOutcome | null): string | null {
	switch (outcome?.status) {
		case 'refused':
			return outcome.why;
		case 'unchanged':
			return UNCHANGED_NOTE;
		case 'not_stale':
			return NOT_STALE_NOTE;
		case 'not_reproposable':
			return NOT_REPROPOSABLE_NOTE;
		default:
			return null;
	}
}

const OUTCOMES: readonly ProposeAgainOutcome['status'][] = [
	'proposed',
	'refused',
	'unchanged',
	'not_stale',
	'not_reproposable',
	'failed'
];

/** An action's data as an outcome; anything else is a failure to prepare it. */
export function outcomeOf(value: unknown): ProposeAgainOutcome {
	if (typeof value !== 'object' || value === null) return { status: 'failed' };
	const { status, id, why } = value as Record<string, unknown>;
	if (!OUTCOMES.includes(status as ProposeAgainOutcome['status'])) return { status: 'failed' };
	if (status === 'proposed' && typeof id === 'string') return { status, id };
	if (status === 'refused' && typeof why === 'string') return { status, why };
	if (status === 'unchanged' || status === 'not_stale' || status === 'not_reproposable') {
		return { status };
	}
	return { status: 'failed' };
}
