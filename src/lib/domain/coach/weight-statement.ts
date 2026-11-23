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
 * Prefer nothing: a question, a hypothetical, someone else's weight, a goal or plan, and a sentence
 * that names a past time (anything but today, this morning, tonight, now, yesterday or last
 * night), a doubt (wish, think, told, says, hope, want, would, could, should) or either day
 * ("today or yesterday") states no weight.
 *
 * The day is read per clause. With one weight in a sentence, a clause with no day takes the
 * sentence's. With two or more, each clause's own day decides and none is inherited: "I was 82.4
 * yesterday but 82.0 today" gives both, "I was 84 kg but now 82.4" gives 82.4 today only ("now"
 * is today), and a clause naming both days, or none, states nothing. A clause opening on a joiner
 * or on "now" ("…, but 82.0 today") continues the body cue before it.
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

const TODAY = new RegExp(`\\b(?:${TODAY_WORDS}|now)\\b`, 'i');
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
/**
 * A clause that opens on a joiner and then the number: "but 82.0 today" continues the one before.
 * "now" may follow the joiner too: "but now 82.4".
 */
const JOINER_ONLY = new RegExp(
	String.raw`^\s*(?:(?:${[...CLAUSE_JOINERS].join('|')})\b\s*)?(?:now\b\s*)?$`,
	'i'
);
/** A clause that opens "and I", as in "…, and I weigh 140". */
const AND_I = /^\s*and\s+i\b/i;
/** A clause that ends on another person, or on "they": the "and I" after it continues their subject. */
const ENDS_ON_OTHER = new RegExp(`(?:${OTHER_PERSON.source}|\\bthey)[,;]?\\s*$`, 'i');
const THEY = /\bthey\b/i;
/** A clause about what the owner would or could weigh, or aims or plans to, is not a weigh-in. */
const NOT_NOW =
	/\b(?:would|could|might|should|i['’]?d|i['’]?ll|will|aim(?:ing|ed)?|goal|target|want(?:ed)? to|hope(?:d)? to|going to|to be)\b/i;
/**
 * A time other than today, yesterday or last night: "last week", "two years ago", "when I started",
 * "back in college", "on Monday", "in 2020". "last night" is not one of them.
 */
const PAST_TIME = new RegExp(
	String.raw`\b(?:last\b(?!\s+night\b)|ago|before|when|since|used\s+to|back\s+in|started|earlier|previously|weeks?|months?|years?|(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)s?|january|february|march|april|may|june|july|august|september|october|november|december|\d{4})\b`,
	'i'
);
/** A doubt about the weight: a wish, a thought, a report, a hope, a want, or a modal. */
const DOUBT =
	/\b(?:wish(?:es|ed)?|think(?:s|ing)?|thought|told|says|said|not\s+sure|hope[ds]?|wants?|wanted|would|could|should)\b/i;
/** "today or yesterday" in either order, with any day word: the sentence does not say which day. */
const EITHER_DAY = new RegExp(
	String.raw`\b(?:${DAY_PHRASE}|now),?\s+or\s+(?:${DAY_PHRASE}|now)\b`,
	'i'
);

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

/** A weight a clause states in the body-cue shape, before its day is read. */
interface Candidate {
	/** The clause it sits in, as written: its own day is read from this text. */
	clause: string;
	number: string;
	unitWord: string | undefined;
}

/** The weights in a sentence that a body cue introduces, clause by clause, before the day. */
function candidatesOf(sentence: string): Candidate[] {
	const found: Candidate[] = [];
	let previous: string | null = null;
	let carrying = false;
	for (const clause of splitClauses(sentence)) {
		const text = clause.text;
		const prior = previous;
		const carried = carrying;
		previous = text;
		carrying = false;
		if (HYPOTHETICAL.test(text) || NOT_NOW.test(text)) continue;
		if (OTHER_PERSON.test(text) || THEY.test(text)) continue;
		// "my wife and I weigh 140" gives the wife's weight: the "and I" continues her.
		if (AND_I.test(text) && prior !== null && ENDS_ON_OTHER.test(prior)) continue;
		for (const match of text.matchAll(NUMBERED)) {
			const before = text.slice(0, match.index);
			if (!(CUE.test(before) || (carried && JOINER_ONLY.test(before)))) continue;
			const [, number, unitWord] = match;
			if (unitOf(unitWord) === null && !/[.,]/.test(number!) && BEING.test(before)) continue;
			if (!WEIGHT_TAIL.test(text.slice(match.index + match[0].length))) continue;
			found.push({ clause: text, number: number!, unitWord });
			carrying = true;
		}
	}
	return found;
}

/**
 * The weights the owner's text states about themselves, in the order they are written. A weight
 * stated in an earlier sentence is still found; a question, hypothetical, doubt, past time or
 * someone else's weight is not.
 */
export function parseWeightStatement(ownerText: string): WeightStatement[] {
	const found: WeightStatement[] = [];
	for (const sentence of splitSentences(ownerText)) {
		if (QUESTION.test(sentence.text) || HYPOTHETICAL.test(sentence.text)) continue;
		if (PAST_TIME.test(sentence.text) || DOUBT.test(sentence.text)) continue;
		if (EITHER_DAY.test(sentence.text)) continue;
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
		const candidates = candidatesOf(sentence.text);
		const several = candidates.length >= 2;
		for (const candidate of candidates) {
			const own = dayWordsOf(candidate.clause);
			// With several weights a clause takes only its own day; with one, the sentence's day too.
			const day = several ? own : (own ?? sentenceDay);
			if (day === 'both' || (several && day === null)) continue;
			found.push({
				value: valueOf(candidate.number),
				unit: unitOf(candidate.unitWord),
				day,
				quote: sentence.text
			});
		}
	}
	return found;
}
