/**
 * Which effort a chat turn runs at (owner decision 2026-11-11: a lighter setting for short
 * questions, so their first words come sooner). The model stays COACH_MODEL: one model keeps one
 * cache and one prompt version, and a short question needs less thinking, not another model.
 *
 * A quick question runs at QUICK_EFFORT; every other turn at CHAT_EFFORT. A question is quick when
 * all of these hold:
 * - it opens its segment: no earlier owner message is replayed with it. A change of top-level
 *   effort invalidates the cached messages, so a quick turn mid-segment would rewrite the whole
 *   segment's cache twice (at low, then back at medium) to save less than that costs
 * - it comes from no entry point: an entry names a record the answer must read
 * - it reports no pain: the safety path keeps the full setting
 * - it is short: at most QUICK_MAX_CHARS characters, on one line, with at most one sentence
 * - it names nothing of the owner's training to read or change (PLANNING_WORDS): no possessive
 *   ("my"), no plan, week, session, change or progress word, so it needs no tool
 */
import type { TurnEntry } from '../tools/context.ts';
import type { Effort } from '../provider/types.ts';
import { CHAT_EFFORT } from './layout.ts';

/** A quick question's effort. */
export const QUICK_EFFORT: Effort = 'low';

/** The longest quick question, in characters. */
export const QUICK_MAX_CHARS = 120;

/** Words that make a question about the owner's own training, or a plan to change it. */
export const PLANNING_WORDS =
	/\b(?:my|mine|me|myself|plans?|planning|program(?:me)?s?|weeks?|weekly|cycles?|blocks?|schedul\w*|sessions?|workouts?|today|tonight|tomorrow|yesterday|swap|replace|change|adjust|move|skip|deload|propos\w*|review|progress\w*|goals?|log(?:ged)?|history|last|next)\b/i;

export interface EffortInput {
	/** The owner's message, as stored. */
	text: string;
	entry: TurnEntry | null;
	/** The owner reported pain (domain/coach/safety.ts). */
	painMode: boolean;
	/** No earlier owner message of the segment is replayed with this one. */
	opensSegment: boolean;
}

/** Whether `text` reads as one short, general question. */
export function isQuickQuestion(text: string): boolean {
	const question = text.trim();
	if (question === '' || Array.from(question).length > QUICK_MAX_CHARS) return false;
	if (/[\r\n]/.test(question)) return false;
	// A sentence end followed by more words is a second sentence.
	if (/[.!?]+\s+\S/.test(question)) return false;
	return !PLANNING_WORDS.test(question);
}

/** The effort a chat turn runs at. */
export function chatEffort(input: EffortInput): Effort {
	const quick =
		input.opensSegment && input.entry === null && !input.painMode && isQuickQuestion(input.text);
	return quick ? QUICK_EFFORT : CHAT_EFFORT;
}
