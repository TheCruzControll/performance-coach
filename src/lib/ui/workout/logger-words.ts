/**
 * The logger's words (SetLogger, through the strength view's Logger): the hint under its load
 * field. Apart from set-words.ts, which the strength view's first render reads, so these load
 * with the logger and never in /workout's initial JavaScript. Pure and Intl-free.
 */
import type { SetFields } from '#lib/domain/workout/logging.ts';
import type { LoadSource, Prefill } from '#lib/domain/workout/prefill.ts';

/** Where a prefilled load came from (prefill.ts's LoadSource), under the logger's load field. */
export const LOAD_FROM_WORDS: Readonly<Record<LoadSource, string>> = {
	prescribed: 'As prescribed',
	top_set_today: "From today's top set",
	previous_set: 'Same as your last set',
	last_session: 'From last time',
	last_top_set: 'From its last top set'
};

/** What an optional load left at 0 means, under its field. */
const BLANK_WORDS: Readonly<Record<'added' | 'assistance', string>> = {
	added: 'Leave at 0 for bodyweight only',
	assistance: 'Leave at 0 for none · less is harder'
};

/**
 * The hint under the logger's load field: where its value came from; else, with nothing
 * prefilled, the set's instruction (a weighted set), or what 0 means (an optional load).
 */
export function loadHint(
	prefill: Pick<Prefill, 'loadFrom' | 'instruction'> & { fields: Pick<SetFields, 'load'> }
): string | null {
	const { loadFrom, instruction, fields } = prefill;
	if (fields.load === null) return null;
	if (loadFrom) return LOAD_FROM_WORDS[loadFrom];
	if (fields.load === 'weight') return instruction ?? 'Enter the weight you use';
	return BLANK_WORDS[fields.load];
}
