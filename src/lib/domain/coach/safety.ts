/**
 * The coach's pain vocabulary (PRD §12, the brief's pain policy): what it may never say, what it
 * may not say once pain is in the conversation, the words that name a diagnosis, and how it reads
 * pain in the owner's own words. Zod-free and client-safe; imported by path.
 *
 * - ALWAYS_BANNED: carrying on through pain (push, work or play through the pain, tough it out,
 *   no pain no gain, ignore the pain…). Never said, in any answer.
 * - PAIN_CONTEXT_PHRASES: push through, keep going, drive through, one more set… Fine about a
 *   sticking point, banned once pain is in the answer or the turn (scanAdvice's painContext).
 * - DIAGNOSIS_PATTERNS: naming a condition, or claiming one. Never said.
 *
 * Together they cover every phrase M4's copy scan bans (domain/workout/copy.test.ts), and
 * copy-scan.test.ts scans M4's workout copy with them.
 *
 * Every pattern is bounded: no `*`, `+` or open `{n,}`, and none can match more than
 * MAX_PATTERN_CHARS characters of scanForm(text) (safety.test.ts computes it from each source).
 * So a streaming gate that holds back a tail of at least that many scan-form characters, and
 * rescans it with what follows, sees every match whole: one that began in released text would be
 * longer than the bound. The rules only ever grow; they never loosen.
 */
import { gentlerHeading, PAIN_COPY } from '../workout/copy.ts';
import type { BodyArea } from '../profile/catalog.ts';
import { parseRef } from './sources.ts';
import { splitClauses, splitSentences } from './sentences.ts';

/** The longest text, in scan-form characters, any pattern below can match (lookaheads included). */
export const MAX_PATTERN_CHARS = 80;

export interface AdvicePattern {
	id: string;
	pattern: RegExp;
}

export type ViolationKind = 'always' | 'pain_context' | 'diagnosis';

export interface AdviceViolation {
	kind: ViolationKind;
	/** The pattern's id. */
	id: string;
	/** Where the match starts in scanForm(text), and what it matched there. */
	index: number;
	match: string;
}

/**
 * The text the patterns read: NFKC, invisible format characters and markdown emphasis marks
 * (`* _ ~` and backticks) dropped, curly apostrophes straightened, hyphens and dashes as spaces,
 * and every run of whitespace as one space. So `push **through**  the pain` and
 * `push-through the pain` are caught. MAX_PATTERN_CHARS is measured on this form.
 */
export function scanForm(text: string): string {
	return text
		.normalize('NFKC')
		.replace(/[\p{Cf}*_~`]/gu, '')
		.replace(/[‘’ʼ′]/g, "'")
		.replace(/[-‐‑‒–—―−]/g, ' ')
		.replace(/\s+/g, ' ');
}

// ---- Fragments ------------------------------------------------------------------------------
// Each is bounded; scanForm has already collapsed whitespace, so one space is enough.

/** What pain is called in advice: the thing nobody should carry on through. */
const HURT_NOUN =
	'(?:pain|pains|hurt|hurting|ache|aches|aching|injury|injuries|niggle|niggles|twinge|twinges|discomfort|soreness|swelling|numbness)';
/** An optional article or softener before it: `the`, `your`, `a little bit of`… */
const DET = '(?:(?:the|your|any|that|this|some|minor|mild|a bit of|a little|a little bit of|an) )?';
/** One optional word between them: `your knee pain`, `the sharp twinge`. */
const ONE_WORD = "(?:[a-z']{1,15} )?";
/** Up to two words: `a rotator cuff injury`. */
const TWO_WORDS = "(?:[a-z']{1,15} ){0,2}";
/** `pain-free` (`pain free` in scan form) is the safe option, never the banned one. */
const NOT_FREE = '(?! ?free)';

function bounded(source: string): RegExp {
	return new RegExp(source, 'i');
}

export const ALWAYS_BANNED: readonly AdvicePattern[] = [
	{
		id: 'through_pain',
		pattern: bounded(
			`\\b(?:push(?:ing|ed)?|work(?:ing|ed)?|play(?:ing|ed)?|power(?:ing|ed)?|grind(?:ing)?|fight(?:ing)?|battl(?:e|ing)|train(?:ing)?|lift(?:ing)?|run(?:ning)?|muscl(?:e|ing)|tough(?:ing)?|soldier(?:ing)?|press(?:ing)?|driv(?:e|ing)|lean(?:ing)?|squat(?:ting)?|grit(?:ting)?|keep going|carry(?:ing)? on|continu(?:e|ing)) (?:on )?(?:through|thru|past|despite|over|into|with) ${DET}${ONE_WORD}${HURT_NOUN}\\b${NOT_FREE}`
		)
	},
	{
		id: 'keep_training_on_pain',
		pattern: bounded(
			`\\b(?:keep|kept|keeping|carry on|continue|continuing) (?:training|lifting|going|running|squatting|pressing|pushing|playing) (?:through|thru|despite|with|even (?:if|though|with)) ${DET}${ONE_WORD}(?:${HURT_NOUN}|it hurts|it's sore|it is sore)\\b${NOT_FREE}`
		)
	},
	{
		id: 'even_if_it_hurts',
		pattern: bounded(
			`\\b(?:even|despite) (?:if|though|when|the fact) (?:it|that|this|your [a-z]{1,15}) (?:hurts|is hurting|is painful|is sore|aches|stings)\\b`
		)
	},
	{ id: 'no_pain_no_gain', pattern: bounded(`\\bno pain,? no gain\\b`) },
	{
		id: 'tough_it_out',
		pattern: bounded(
			`\\b(?:tough|gut|grit|suck|walk|shake|sweat|run) (?:it|this|that) (?:out|up|off)\\b`
		)
	},
	{
		id: 'man_up',
		pattern: bounded(`\\b(?:man up|harden up|grit your teeth|rub some dirt on it)\\b`)
	},
	{
		id: 'pain_is_fine',
		pattern: bounded(
			`\\b(?:(?:a little|a bit of|some|mild) )?(?:pain|discomfort|hurting) is (?:just |only )?(?:weakness|good|fine|ok|okay|normal|expected|acceptable|nothing|part of)\\b`
		)
	},
	{
		id: 'ignore_pain',
		pattern: bounded(
			`\\b(?:ignore|ignoring|disregard|forget about|don't worry about|do not worry about|never mind) ${DET}${ONE_WORD}${HURT_NOUN}\\b${NOT_FREE}`
		)
	},
	{
		id: 'minimise_pain',
		pattern: bounded(
			`\\b(?:nothing (?:serious|to worry about)|(?:just|only|probably|likely) (?:a )?(?:niggle|twinge))\\b`
		)
	}
];

export const PAIN_CONTEXT_PHRASES: readonly AdvicePattern[] = [
	{
		id: 'push_through',
		pattern: bounded(
			`\\b(?:push|pushing|power|powering|work|working|grind|grinding|fight|fighting|battle|battling|drive|driving|muscle|muscling|soldier|soldiering|play|playing|train|training|lift|lifting|press|pressing|break|breaking) (?:on )?(?:through|thru|past)\\b`
		)
	},
	{
		id: 'push_on',
		pattern: bounded(
			`\\b(?:push|pushing|power|powering|press|pressing|soldier|soldiering|crack|cracking|plough|ploughing|plow|plowing|carry|carrying) on\\b`
		)
	},
	{
		id: 'keep_going',
		pattern: bounded(
			`\\b(?:keep|keeps|kept|keeping) (?:going|pushing|grinding|at it|lifting|training|squatting|running|pressing|working|it up)\\b`
		)
	},
	{
		id: 'continue',
		pattern: bounded(
			`\\bcontinu(?:e|ing) (?:lifting|training|running|as planned|the (?:set|sets|exercise|movement|session|workout)|with (?:the|your|it|that|this))\\b`
		)
	},
	{
		id: 'dont_stop',
		pattern: bounded(`\\b(?:don't|do not|never) (?:stop|quit|give up|back off|ease off)\\b`)
	},
	{
		id: 'finish_the_set',
		pattern: bounded(
			`\\b(?:finish|finishing|complete|completing|get through|grind out|bang out|knock out) (?:the |your |this |that |those |these |all |all the |the rest of the |the remaining |the last )?(?:[a-z]{1,12} )?(?:set|sets|rep|reps|session|workout)\\b`
		)
	},
	{
		id: 'one_more',
		pattern: bounded(`\\b(?:one|two|a couple|a few|just a few|just) more (?:rep|reps|set|sets)\\b`)
	},
	{
		id: 'stick_with_it',
		pattern: bounded(
			`\\bstick (?:with|at) (?:it|them|that|this|the (?:set|sets|exercise|plan|movement))\\b`
		)
	},
	{
		id: 'it_will_ease',
		pattern: bounded(
			`\\b(?:it|the pain|that|this|the ache|the discomfort)(?: will|'ll| should| usually| often| tends to| might| may) (?:go away|ease|ease off|settle|settle down|wear off|loosen up|warm up|disappear|pass|fade)\\b`
		)
	}
];

export const DIAGNOSIS_PATTERNS: readonly AdvicePattern[] = [
	{ id: 'diagnose', pattern: bounded(`\\bdiagnos(?:e|es|ed|is|ing|tic|tics)\\b`) },
	{ id: 'tendon_condition', pattern: bounded(`\\btend[io]n(?:itis|opathy|osis)\\b`) },
	{ id: 'itis', pattern: bounded(`\\b[a-z]{2,20}itis\\b`) },
	{ id: 'tear', pattern: bounded(`\\b(?:tear|tears|torn|ruptur(?:e|ed|es))\\b`) },
	{
		id: 'sprain_strain',
		pattern: bounded(`\\b(?:sprain|sprains|sprained|strain|strains|strained)\\b`)
	},
	{
		id: 'fracture',
		pattern: bounded(`\\b(?:fractur(?:e|es|ed)|broken bone|stress reaction)\\b`)
	},
	{ id: 'impingement', pattern: bounded(`\\bimping(?:e|es|ed|ement|ing)\\b`) },
	{
		id: 'named_condition',
		pattern: bounded(
			`\\b(?:sciatica|herniat(?:ed|ion)|(?:slipped|bulging|prolapsed) dis[ck]|dislocat(?:e|ed|ion)|sublux(?:ed|ation)|shin splints|tennis elbow|golfer's elbow|runner's knee|jumper's knee|frozen shoulder|labrum|labral|menisc(?:us|al)|(?:acl|mcl|pcl|ucl)|ligament damage|nerve damage|(?:pinched|trapped) nerve|hernia|inflam(?:ed|mation|matory))\\b`
		)
	},
	{
		id: 'claims_condition',
		pattern: bounded(
			`\\b(?:you|you've|you have|it|this|that) (?:probably|likely|might|may|must|could)(?: have| be|'ve)? (?:(?:a|an|some|got a|got an) )?${TWO_WORDS}(?:injury|injured|damage|damaged|condition|syndrome|lesion)\\b`
		)
	},
	{
		id: 'sounds_like',
		pattern: bounded(
			`\\b(?:sounds|looks|seems|feels) like (?:a|an|you have|you've got|you've) ${TWO_WORDS}(?:injury|injured|damage|condition|syndrome|problem with your)\\b`
		)
	},
	{
		id: 'you_injured',
		pattern: bounded(
			`\\byou(?:'ve| have)? (?:injured|damaged|pulled|tweaked|torn|strained|sprained) (?:a|an|your)\\b`
		)
	}
];

/**
 * Words that bring pain into an answer: a block holding one is the gate's pain context. Broad on
 * purpose (soreness counts), unlike detectPain, which reads whether the owner reports pain.
 */
export const PAIN_WORDS: readonly AdvicePattern[] = [
	{
		id: 'pain_word',
		pattern: bounded(
			`\\b(?:pain|pains|painful|painkillers?|hurt|hurts|hurting|ache|aches|aching|achy|sore|soreness|injur(?:y|ies|ed)|twinges?|niggles?|niggling|swelling|swollen|numb|numbness|tingl(?:e|es|ing)|discomfort|tender|tenderness|tweaked|throbbing|stabbing)\\b`
		)
	}
];

function matches(form: string, patterns: readonly AdvicePattern[], kind: ViolationKind) {
	return patterns.flatMap(({ id, pattern }) =>
		[...form.matchAll(new RegExp(pattern.source, 'gi'))].map((m): AdviceViolation => ({
			kind,
			id,
			index: m.index,
			match: m[0]
		}))
	);
}

/** Whether the text names pain, soreness or an injury (PAIN_WORDS). */
export function hasPainWord(text: string): boolean {
	return PAIN_WORDS.some(({ pattern }) => pattern.test(scanForm(text)));
}

/** Whether the text holds a phrase banned only with pain (PAIN_CONTEXT_PHRASES). */
export function hasContextPhrase(text: string): boolean {
	const form = scanForm(text);
	return PAIN_CONTEXT_PHRASES.some(({ pattern }) => pattern.test(form));
}

/**
 * What the text says that the coach may not, in order. The context phrases count when
 * `painContext` is set (the turn is in pain mode, or the whole answer names pain) and whenever the
 * text itself names pain.
 */
export function scanAdvice(
	text: string,
	{ painContext }: { painContext: boolean }
): AdviceViolation[] {
	const form = scanForm(text);
	const context = painContext || PAIN_WORDS.some(({ pattern }) => pattern.test(form));
	return [
		...matches(form, ALWAYS_BANNED, 'always'),
		...matches(form, DIAGNOSIS_PATTERNS, 'diagnosis'),
		...(context ? matches(form, PAIN_CONTEXT_PHRASES, 'pain_context') : [])
	].sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
}

// ---- Pain in the owner's words ---------------------------------------------------------------

export interface PainSignal {
	/** Whether the owner reports pain (training soreness is not pain). */
	reported: boolean;
	/** Where, when the owner says. */
	area?: BodyArea;
	/** Sharp, swelling, numbness, a pop and the like: see a professional. */
	severe: boolean;
}

/** Words that report pain wherever they are. */
const PAIN_CUE =
	/\b(?:pain|pains|painful|painkillers?|hurts?|hurting|injur(?:y|ies|ed)|twinge[sd]?|niggles?|niggling|niggly|tweaked|pinch(?:es|ing)?|swelling|swollen|swelled|numb|numbness|tingl(?:e|es|ing)|pins and needles|popped|(?:a|felt a|heard a) pop|gave (?:out|way)|locked up|stabbing|shooting|throbbing|(?:pulled|tore|torn) (?:a|my)|pulled something|sprain(?:s|ed)?|strained|(?:a|my) (?:[a-z]{2,15} )?strain|rolled (?:my|an?) (?:left |right )?(?:ankle|foot|wrist)|[a-z]{2,20}itis|torn(?! between)|(?:a|the) tear|impinge(?:d|ment))\b/i;
/** Words that report pain about a named area: 'sharp in my hamstring'. */
const AREA_CUE = /\b(?:sharp|killing me)\b/i;
/** Words that report pain only about a joint: muscles are sore after training. */
const JOINT_CUE = /\b(?:sore|soreness|ache[sd]?|aching|achy)\b/i;
const SEVERE_CUE =
	/\b(?:sharp|stabbing|shooting|swelling|swollen|swelled|numb|numbness|tingl(?:e|es|ing)|pins and needles|popped|pop|gave (?:out|way)|locked up|can'?t (?:move|bear weight|put weight|walk|straighten|bend|lift)|severe|excruciating|unbearable|agony)\b/i;
/** Pain said not to be there: removed from a clause before its cues are read. */
const NO_PAIN = [
	/\b(?:no|zero|without(?: any)?|free of|not any|no more|nothing) (?:[a-z]{1,12} )?(?:pain|hurts?|aches?|soreness|niggles?|twinges?)\b/gi,
	/\bpain ?free\b|\bpainless\b|\b(?:not|never) in (?:any )?pain\b/gi,
	/\b(?:doesn'?t|does not|didn'?t|did not|don'?t|do not|won'?t|will not|wouldn'?t|would not|isn'?t|is not|wasn'?t|was not|never|no longer|not) (?:really |actually |even )?(?:hurt|hurts|hurting|painful|sore|ache|aching)\b(?! (?:much|as much|that much|too much|a lot|a bit|a little))/gi,
	/\b(?:the )?pain(?:'s| is| has)? (?:gone|went away|stopped|disappeared|cleared)\b/gi
];

/**
 * What the owner may call each area. 'my back' (never 'back squat' or 'the back of') reads as the
 * lower back, where most back pain in lifting is.
 */
const AREA_TERMS: readonly [string, BodyArea][] = [
	['(?:upper|mid|middle) back|shoulder blades?|traps?|thoracic', 'upper_back'],
	['(?:lower|low) back|lumbar', 'lower_back'],
	['neck', 'neck'],
	['shoulders?|rotator cuff', 'shoulder'],
	['elbows?', 'elbow'],
	['wrists?|hands?|fingers?|thumbs?|knuckles?', 'wrist_hand'],
	['hips?|hip flexors?|glutes?|pelvis', 'hip'],
	['groin|adductors?|inner thighs?', 'groin'],
	['hamstrings?|hammy|hammies', 'hamstring'],
	['knees?|kneecaps?|patella', 'knee'],
	['shins?|calf|calves|achilles', 'shin_calf'],
	['ankles?|foot|feet|heels?|toes?|arch(?:es)?', 'ankle_foot'],
	['chest|pecs?|ribs?|abs|quads?|biceps?|triceps?|forearms?|jaw', 'other']
];
const OWNER = '(?:(?:my|the|your|both)(?: left| right)?|left|right)';
/** An area as the owner's own ('my left knee'), which beats a bare one ('hip thrusts'). */
const OWNED_AREAS: readonly [RegExp, BodyArea][] = [
	...AREA_TERMS.map(([term, area]): [RegExp, BodyArea] => [
		new RegExp(`\\b${OWNER} (?:${term})\\b`, 'i'),
		area
	]),
	[/\b(?:my|the|your) back\b(?! (?:squats?|extensions?|rows?|off|of))/i, 'lower_back']
];
const BARE_AREAS: readonly [RegExp, BodyArea][] = AREA_TERMS.map(([term, area]) => [
	new RegExp(`\\b(?:${term})\\b`, 'i'),
	area
]);

/** Areas where soreness or an ache is pain rather than training soreness. */
const JOINT_AREAS: ReadonlySet<BodyArea> = new Set([
	'neck',
	'shoulder',
	'elbow',
	'wrist_hand',
	'lower_back',
	'hip',
	'groin',
	'knee',
	'ankle_foot'
]);

function firstOf(text: string, terms: readonly [RegExp, BodyArea][]): BodyArea | undefined {
	let best: { at: number; area: BodyArea } | undefined;
	for (const [pattern, area] of terms) {
		const at = text.search(pattern);
		if (at >= 0 && (!best || at < best.at)) best = { at, area };
	}
	return best?.area;
}

/** The area the text names: the first the owner calls their own, else the first named. */
function areaIn(text: string): BodyArea | undefined {
	return firstOf(text, OWNED_AREAS) ?? firstOf(text, BARE_AREAS);
}

/**
 * Whether the owner's words report pain, where, and whether it is severe. Read clause by clause:
 * pain said not to be there ('no pain', 'pain-free', "doesn't hurt anymore") is left out, soreness
 * and aches count only about a joint ('sore from Monday' and 'my quads are sore' are training),
 * and the area comes from the clause, else its sentence, else the message.
 */
export function detectPain(text: string): PainSignal {
	const form = scanForm(text);
	let reported = false;
	let severe = false;
	let area: BodyArea | undefined;
	for (const sentence of splitSentences(form)) {
		const before: boolean = reported;
		for (const clause of splitClauses(sentence.text)) {
			const said = NO_PAIN.reduce((rest, pattern) => rest.replace(pattern, ' '), clause.text);
			const where = areaIn(said);
			const joint = where !== undefined && JOINT_AREAS.has(where);
			const cued =
				PAIN_CUE.test(said) ||
				(where !== undefined && AREA_CUE.test(said)) ||
				(joint && JOINT_CUE.test(said));
			if (!cued) continue;
			reported = true;
			severe ||= SEVERE_CUE.test(said);
			area ??= where ?? areaIn(sentence.text);
		}
		// A cue a clause boundary cut in two: 'pins and needles'.
		const said = NO_PAIN.reduce((rest, pattern) => rest.replace(pattern, ' '), sentence.text);
		if (reported === before && PAIN_CUE.test(said)) {
			reported = true;
			severe ||= SEVERE_CUE.test(said);
			area ??= areaIn(said);
		}
	}
	if (!reported) return { reported: false, severe: false };
	area ??= areaIn(form);
	return area ? { reported, area, severe } : { reported, severe };
}

// ---- Safe guidance ----------------------------------------------------------------------------

export interface GentlerOption {
	/** The exercise's id, cited as a ref when it is one an answer may carry. */
	id?: string;
	name: string;
}

/** Said when no gentler option was found (the plan's generic option). */
export const GENERIC_GENTLER = 'a lighter variation, or rest that movement today';

/** At most this many gentler options are named. */
export const MAX_GENTLER = 3;

function listed(names: readonly string[]): string {
	if (names.length <= 1) return names.join('');
	return `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
}

/** An option as the answer grammar carries it: a ref where it can be one, else its plain name. */
function option({ id, name }: GentlerOption): string | null {
	const label = name
		.replace(/[[\]|\\\n]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!label || scanAdvice(label, { painContext: true }).length > 0) return null;
	const ref = id ? `exercise:${id}|${label}` : null;
	return ref && parseRef(ref)?.label === label ? `[[${ref}]]` : label;
}

/**
 * The [safety] block a pain turn must carry: stop the movement; the gentler options (this turn's
 * alternatives, else a lighter variation or rest); a professional when the pain is sharp or
 * persists; Profile → Injuries when it keeps coming back. It never names a diagnosis, and it
 * passes scanAdvice in pain context whatever names it is given (one that would not is left out,
 * and a list that would not together falls back to GENERIC_GENTLER).
 */
export function safeGuidance({
	area,
	alternatives
}: {
	area?: BodyArea | null;
	alternatives: readonly GentlerOption[];
}): string {
	const names = alternatives
		.map(option)
		.filter((name): name is string => name !== null)
		.filter((name, i, all) => all.indexOf(name) === i)
		.slice(0, MAX_GENTLER);
	const heading = area ? gentlerHeading(area) : 'A gentler option';
	const named = `${heading}: ${listed(names)}.`;
	const gentler =
		names.length > 0 && scanAdvice(named, { painContext: true }).length === 0
			? named
			: `${heading}: ${GENERIC_GENTLER}.`;
	return [
		'[safety] Stop the movement that hurts; stopping is always OK.',
		gentler,
		PAIN_COPY.professional,
		'If it keeps coming back, add it to Profile → Injuries so your plan works around it.'
	].join(' ');
}
