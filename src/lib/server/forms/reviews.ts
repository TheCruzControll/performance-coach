/**
 * Form actions for a weekly review's next-week card (M6 review-adjustments-ui): the owner check,
 * the owner's choices as the card posts them, then decideNextWeek's outcome or failure as what
 * the card shows. The service stays the authority and checks every choice again.
 *
 * The form: `reviewId`; each ticked change as an `item` (its id); a change's choice as
 * `choice:<id>`, 'proposed' or 'half_step' (proposed when absent); Keep's optional `note`.
 * - applied → { outcome: 'applied', words, href }: the toast, and Train at the week that holds
 *   next week; Keep on a review applied meanwhile → { outcome: 'applied' }: the card, reloaded
 * - rejected, too_late, superseded → { outcome }: the card, reloaded, shows it
 * - Generate with nothing ticked, ReviewInputError or CoachInputError →
 *   `fail(400, { reason: 'invalid', message })`
 * - a missing review or proposal → `fail(404, { reason: 'not_found' })`
 * - a newer revision of the review → `fail(409, { reason: 'refreshed' })`; a proposal already
 *   decided → `fail(409, { reason: 'decided' })`; any ConflictError →
 *   `fail(409, { reason: 'conflict', conflict })` with its own reason
 * Anything else is rethrown, for handleError to record as the server's error.
 */
import { fail } from '@sveltejs/kit';
import { addDays, daysBetween, type IsoDate } from '../../domain/calendar';
import { CoachInputError, CoachNotFoundError } from '../services/coach/shared';
import { ProposalClosedError } from '../services/coach/proposals';
import { getCurrentProgram } from '../services/programs/index';
import {
	decideNextWeek,
	ReviewInputError,
	ReviewNotFoundError,
	ReviewSupersededError,
	type NextWeekItem,
	type ReviewDeps
} from '../services/reviews/index';
import { ConflictError } from '../services/training/shared';

/** The toast once next week is generated: 'Next week updated · version 4 · 2 changes were…'. */
export function appliedWords(versionNumber: number | null, passed: number): string {
	const updated =
		versionNumber === null ? 'Next week updated' : `Next week updated · version ${versionNumber}`;
	if (passed === 0) return updated;
	return `${updated} · ${passed} ${passed === 1 ? 'change was' : 'changes were'} for sessions already past`;
}

/** Generate with every change left out: keeping next week as planned is its own action. */
export const NOTHING_TICKED = 'Tick at least one change, or keep next week as planned.';

/** The posted choices: each ticked change once, at the choice posted beside it. */
export function choicesOf(form: FormData): {
	reviewId: string;
	items: NextWeekItem[];
	note: string | null;
} {
	const ids = [...new Set(form.getAll('item').map(String))];
	const note = String(form.get('note') ?? '').trim();
	return {
		reviewId: String(form.get('reviewId') ?? ''),
		items: ids.map((id) => ({
			id,
			choice: form.get(`choice:${id}`) === 'half_step' ? 'half_step' : 'proposed'
		})),
		note: note || null
	};
}

/** What the action runs on: the app's database and clock unless given (a test's transaction). */
export type DecideReviewDeps = ReviewDeps;

/**
 * Decide on the review of the week from `weekStartsOn`: 'decide' applies the ticked changes,
 * 'keep' takes none, with the note. Once applied, Train opens at the week that holds next week.
 */
export async function decideReview(
	ownerId: string,
	{ form, mode, weekStartsOn }: { form: FormData; mode: 'decide' | 'keep'; weekStartsOn: IsoDate },
	deps: DecideReviewDeps = {}
) {
	const { reviewId, items, note } = choicesOf(form);
	if (mode === 'decide' && items.length === 0)
		return fail(400, { reason: 'invalid' as const, message: NOTHING_TICKED });
	try {
		const input = mode === 'keep' ? { items: [], note } : { items };
		const result = await decideNextWeek(ownerId, reviewId, input, deps);
		// Keep on a review applied meanwhile (another tab, M5's inbox): the card reloads to say so.
		if (result.outcome !== 'applied' || mode === 'keep') return { outcome: result.outcome };
		const next = addDays(weekStartsOn, 7);
		const program = await getCurrentProgram(ownerId, next, { db: deps.db });
		// Train's ?week counts weeks from the program's start, gaps between blocks included.
		const n = program && daysBetween(program.startsOn, next) / 7 + 1;
		return {
			outcome: result.outcome,
			words: appliedWords(result.versionNumber, result.passed),
			href: n ? `/train?week=${n}` : '/train'
		};
	} catch (err) {
		if (err instanceof ReviewInputError || err instanceof CoachInputError)
			return fail(400, { reason: 'invalid' as const, message: err.message });
		if (err instanceof ReviewNotFoundError || err instanceof CoachNotFoundError)
			return fail(404, { reason: 'not_found' as const });
		if (err instanceof ReviewSupersededError) return fail(409, { reason: 'refreshed' as const });
		if (err instanceof ProposalClosedError) return fail(409, { reason: 'decided' as const });
		if (err instanceof ConflictError)
			return fail(409, { reason: 'conflict' as const, conflict: String(err.reason) });
		throw err;
	}
}
