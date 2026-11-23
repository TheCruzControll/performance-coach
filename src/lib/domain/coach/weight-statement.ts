/**
 * Whether the owner's own words state their body weight in this message (the weight plan's PR 8).
 * log_body_weight records a weigh-in only when a weight it names is one of these statements, so the
 * coach never writes a number the owner did not give, nor one it worked out. Zod-free and
 * client-safe; imported by path.
 *
 * A weight is stated in one of two shapes:
 * - a bare weigh-in: a sentence that is only the number, with its unit and a day, or a decimal
 *   with its unit ("82,4kg", "82.4 this morning", "180 lb yesterday"); a bare "82.5" or "100"
 *   states nothing, since it could be anything;
 * - a number that a body cue comes straight before, within its clause, and that is followed in
 *   the clause only by its unit, an optional day, "now" or "on the scale": "I weighed 82.4 this
 *   morning", "yesterday I was 180 lb", "my weight is 82", "I'm at 82.4 kg". A whole number after
 *   "I'm", "I am" or "I was" needs a unit or a decimal, since "I'm 30" may be an age.
 *
 * Nothing else states one, and the rest is read with the statement rules of ./statements.ts: a
 * question ("is 82 good?"), a hypothetical ("if I were 80…", anywhere in its sentence) and someone
 * else's weight ("my partner weighs 60", "my wife and I weigh 140") state none. Neither does a goal
 * or a plan ("I'd weigh 80", "aiming for 80"), nor a number that is not a body weight ("3 sets at
 * 80kg", "I'm doing 80kg squats"), nor a weight with a time that is not today or yesterday ("I was
 * 85 last year", "I weighed 82.4 on Monday"). When in doubt nothing is stated, so nothing is
 * written.
 *
 * The day is read per clause: a clause that names today or yesterday gives its own day, and a
 * clause that names none takes the sentence's. A clause naming both states nothing, and so does a
 * clause with no day of its own in a sentence that names both. A clause that opens on a joiner
 * ("…, but 82.0 today") takes the cue of the clause before it. The day is 'today' when the words
 * say today, this morning or the like, 'yesterday' when they say yesterday, and null when they name
 * no day at all.
 */
import type { WeightUnit } from '../units.ts';
import { CLAUSE_JOINERS, splitClauses, splitSentences } from './sentences.ts';
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
/** A state of being, "I'm", "I am", "I was": a whole number after one may be an age or a height. */
const BEING = /\bi\s*(?:['’]m|\s+am|\s+was)\b/i;
/** What may follow a weight in its clause: a day, "now" or "on the scale", then punctuation. */
const WEIGHT_TAIL = new RegExp(
	String.raw`^\s*(?:(?:${DAY_PHRASE}|now|on the scale)\b\s*)?[.,;:!]?$`,
	'i'
);
/** A clause that opens on a joiner and then the number: "but 82.0 today" continues the one before. */
const JOINER_ONLY = new RegExp(
	String.raw`^\s*(?:(?:${[...CLAUSE_JOINERS].join('|')})\b\s*)?$`,
	'i'
);
/** A clause that opens "and I", as in "…, and I weigh 140". */
const AND_I = /^\s*and\s+i\b/i;
/** A clause that ends on another person, or on "they": the "and I" after it continues their subject. */
const ENDS_ON_OTHER = new RegExp(`(?:${OTHER_PERSON.source}|\\bthey)\\s*$`, 'i');
const THEY = /\bthey\b/i;
/** A clause about what the owner would or could weigh, or aims or plans to, is not a weigh-in. */
const NOT_NOW =
	/\b(?:would|could|might|should|i['’]?d|i['’]?ll|will|aim(?:ing|ed)?|goal|target|want(?:ed)? to|hope(?:d)? to|going to|to be)\b/i;

/** The day a text names: 'both' when it names today and yesterday, null when it names neither. */
function dayWordsOf(text: string): 'today' | 'yesterday' | 'both' | null {
	const today = TODAY.test(text);
	const yesterday = YESTERDAY.test(text);
	if (today && yesterday) return 'both';
	if (today) return 'today';
	return yesterday ? 'yesterday' : null;
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
		if (QUESTION.test(sentence.text) || HYPOTHETICAL.test(sentence.text)) continue;
		const sentenceDay = dayWordsOf(sentence.text);
		const bare = BARE.exec(sentence.text);
		if (bare) {
			const [, number, unit] = bare;
			const decimal = /[.,]/.test(number!);
			// A bare number needs a day, or a decimal with its unit: "82.5" and "100" state nothing.
			if (sentenceDay === 'both' || (sentenceDay === null && !(decimal && unit))) continue;
			found.push({
				value: valueOf(number!),
				unit: unitOf(unit),
				day: sentenceDay,
				quote: sentence.text
			});
			continue;
		}
		let previous: string | null = null;
		let carrying = false;
		for (const clause of splitClauses(sentence.text)) {
			const text = clause.text;
			const prior = previous;
			const carried = carrying;
			previous = text;
			carrying = false;
			if (HYPOTHETICAL.test(text) || NOT_NOW.test(text)) continue;
			if (OTHER_PERSON.test(text) || THEY.test(text)) continue;
			// "my wife and I weigh 140" gives the wife's weight: the "and I" continues her.
			if (AND_I.test(text) && prior !== null && ENDS_ON_OTHER.test(prior)) continue;
			const clauseDay = dayWordsOf(text) ?? sentenceDay;
			if (clauseDay === 'both') continue;
			for (const match of text.matchAll(NUMBERED)) {
				const before = text.slice(0, match.index);
				if (!(CUE.test(before) || (carried && JOINER_ONLY.test(before)))) continue;
				const [, number, unitWord] = match;
				const unit = unitOf(unitWord);
				if (unit === null && !/[.,]/.test(number!) && BEING.test(before)) continue;
				if (!WEIGHT_TAIL.test(text.slice(match.index + match[0].length))) continue;
				found.push({
					value: valueOf(number!),
					unit,
					day: clauseDay,
					quote: sentence.text
				});
				carrying = true;
			}
		}
	}
	return found;
}
