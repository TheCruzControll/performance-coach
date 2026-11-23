/**
 * Whether the owner's own words state their body weight in this message (the weight plan's PR 8).
 * log_body_weight records a weigh-in only when a weight it names is one of these statements, so the
 * coach never writes a number the owner did not give, nor one it worked out. Zod-free and
 * client-safe; imported by path.
 *
 * A weight is stated in one of two shapes:
 * - a bare weigh-in: a sentence that is only the number, with a decimal point or comma or a day
 *   ("82,4kg", "82.4 this morning", "180 lb yesterday");
 * - a number that a body cue comes straight before, within its clause: "I weighed 82.4 this
 *   morning", "yesterday I was 180 lb", "my weight is 82", "I'm at 82.4 kg".
 *
 * Nothing else states one, and the rest is read with the statement rules of ./statements.ts: a
 * question ("is 82 good?"), a hypothetical ("if I were 80…") and someone else's weight ("my partner
 * weighs 60") state none. Neither does a goal or a plan ("I'd weigh 80", "aiming for 80"), nor a
 * number that is not a body weight ("3 sets at 80kg", "I'm doing 80kg squats"). When in doubt
 * nothing is stated, so nothing is written.
 *
 * The day is 'today' when the sentence says today, this morning or the like, 'yesterday' when it
 * says yesterday, and null when it says neither or both.
 */
import type { WeightUnit } from '../units.ts';
import { splitClauses, splitSentences } from './sentences.ts';
import { HYPOTHETICAL, OTHER_PERSON, QUESTION } from './statements.ts';

/** A weight the owner states: its value as written, its unit if they wrote one, and its day. */
export interface WeightStatement {
	value: number;
	/** null when the owner wrote no unit: the profile's unit applies. */
	unit: WeightUnit | null;
	day: 'today' | 'yesterday' | null;
	/** The sentence the weight came from, as the owner wrote it. */
	quote: string;
}

const UNIT = String.raw`kilograms?|kilos?|kgs?|pounds?|lbs?`;
const NUMBER = String.raw`\d{2,3}(?:[.,]\d{1,2})?`;
const TODAY_WORDS = String.raw`today|this morning|this afternoon|this evening|tonight|just now|on waking|first thing`;
const DAY_PHRASE = `${TODAY_WORDS}|yesterday`;

const TODAY = new RegExp(`\\b(?:${TODAY_WORDS})\\b`, 'i');
const YESTERDAY = /\byesterday\b/i;
/** A sentence that is only a weigh-in: the number, its unit and at most a day. */
const BARE = new RegExp(
	`^(?:(?:${DAY_PHRASE})[,:]?\\s+)?(${NUMBER})(?:\\s*(${UNIT}))?(?:\\s+(?:${DAY_PHRASE}))?\\s*[.!]?$`,
	'i'
);
/** A number in a clause, not part of a longer one, with the unit written straight after it. */
const NUMBERED = new RegExp(`(?<![\\d.,])(${NUMBER})(?![\\d]|[.,]\\d)(?:\\s*(${UNIT})\\b)?`, 'gi');
/** Words that may sit between the body cue and the number: "I weighed in at 82.4". */
const FILLER = String.raw`(?:is|was|of|at|in|about|around|roughly|approximately|approx\.?|now|just|currently|still|came|to|on)`;
/** The owner speaking of their own weight, directly before the number. */
const CUE = new RegExp(
	String.raw`(?:\bi\s*(?:['’]m|\s+am|\s+was|\s+(?:just\s+|now\s+)?weigh(?:ed|s)?)|\bmy\s+(?:body\s*)?(?:weight|weigh-?in|scale)|^\s*weigh(?:ed|ing)?)(?:\s+${FILLER})*\s*$`,
	'i'
);
/** A clause about what the owner would or could weigh, or aims or plans to, is not a weigh-in. */
const NOT_NOW =
	/\b(?:would|could|might|should|i['’]?d|i['’]?ll|will|aim(?:ing|ed)?|goal|target|want(?:ed)? to|hope(?:d)? to|going to|to be)\b/i;
/** A third person's weight, by a pronoun the owner's clause names them with. */
const THEY = /\bthey\b/i;

function dayOf(sentence: string): WeightStatement['day'] {
	const today = TODAY.test(sentence);
	const yesterday = YESTERDAY.test(sentence);
	if (today === yesterday) return null;
	return today ? 'today' : 'yesterday';
}

/** A unit word as the statement's unit: kg or lb, however the owner spelled it. */
function unitOf(word: string | undefined): WeightUnit | null {
	if (!word) return null;
	return /^(?:kg|kilo)/i.test(word) ? 'kg' : 'lb';
}

const valueOf = (text: string) => Number(text.replace(',', '.'));

/**
 * The weights the owner's text states about themselves, in the order they are written. A weight
 * stated in an earlier sentence is still found; a question, hypothetical or someone else's weight
 * is not.
 */
export function parseWeightStatement(ownerText: string): WeightStatement[] {
	const found: WeightStatement[] = [];
	for (const sentence of splitSentences(ownerText)) {
		if (QUESTION.test(sentence.text)) continue;
		const day = dayOf(sentence.text);
		const bare = BARE.exec(sentence.text);
		if (bare) {
			const [, number, unit] = bare;
			const decimal = /[.,]/.test(number!);
			if (decimal || day !== null) {
				found.push({
					value: valueOf(number!),
					unit: unitOf(unit),
					day,
					quote: sentence.text
				});
			}
			continue;
		}
		for (const clause of splitClauses(sentence.text)) {
			const text = clause.text;
			if (HYPOTHETICAL.test(text) || NOT_NOW.test(text)) continue;
			if (OTHER_PERSON.test(text) || THEY.test(text)) continue;
			for (const match of text.matchAll(NUMBERED)) {
				const before = text.slice(0, match.index);
				if (!CUE.test(before)) continue;
				found.push({
					value: valueOf(match[1]!),
					unit: unitOf(match[2]),
					day,
					quote: sentence.text
				});
			}
		}
	}
	return found;
}
