/**
 * Whether the owner's own words state a lasting preference about an exercise, or only today's
 * situation (PRD §4, §14; the brief: 'I dislike X' persists, 'machine unavailable' never does).
 * update_exercise_preferences writes a preference only on an explicit dislike or like found here;
 * a situational statement sends it to substitute_exercise with scope session. Zod-free and
 * client-safe; imported by path.
 *
 * The exercise matcher is injected (the agent passes M3's matchExercise with the owner's library),
 * so this module never reaches the catalogue. Every run of up to MAX_NAME_WORDS words is offered
 * to it, longest first and leftmost first, and a phrase it does not match names nothing.
 *
 * The rule, deterministic and conservative (when in doubt, nothing is written):
 * - Each sentence is read clause by clause (./sentences.ts), with the exercise names masked.
 * - A hypothetical ('if I hated…') or someone else's view ('my partner hates…') states nothing,
 *   nor does a negated dislike ("I don't mind lunges"), a negated love, or a past view ('I used to
 *   hate…', '…last session'). A question states no
 *   preference ('Do I like squats?'), though it can state a situation ('The rack is broken, can I
 *   swap squats?').
 * - A situational cue (taken, busy, broken, today, right now, travelling, pain…) makes the clause
 *   situational, whatever else it says: "I hate that the leg press is taken" is situational.
 * - Otherwise a dislike cue (hate, can't stand, not a fan of, never give me… again, a negated
 *   like) or a like cue ('I love', 'my favourite') states that preference. In a comparison ('more
 *   than', 'over', 'instead of'), only what comes before the comparison is stated. A clause that
 *   is only more names ('I love squats and lunges') says what the clause before it says.
 * - A clause that names no exercise applies to the sentence's: a situational one to all of them
 *   ('I hate lunges, at least today'), a preference one through a pronoun ('…, so never give me
 *   them again') to the clause before. A sentence that names none, through a pronoun, applies to
 *   the last exercises named ('I hate lunges. Never give me them again.').
 * - Within a sentence, situational wins; across sentences, an explicit preference wins over a
 *   situation. A dislike and a like of the same exercise cancel out to none.
 */
import { splitClauses, splitSentences, type TextSpan } from './sentences.ts';

export const STATEMENT_KINDS = ['dislike', 'like', 'situational', 'none'] as const;
export type StatementKind = (typeof STATEMENT_KINDS)[number];

/** What the owner said about one exercise. */
export interface ExerciseStatement {
	/** The key the matcher returned. */
	exercise: string;
	kind: StatementKind;
	/** The owner's words that decided it, as written. */
	quote: string;
}

/** M3's matchExercise: the key of the one exercise `text` names, or null. */
export type ExerciseMatcher<C> = (text: string, candidates: readonly C[]) => string | null;

/** The longest exercise name, in words, offered to the matcher. */
export const MAX_NAME_WORDS = 6;

const QUESTION = /\?\s*$/;
const HYPOTHETICAL = /\b(?:if|unless|whether|suppose|supposing|imagine|what if|would you)\b/i;
const SOMEONE_ELSE =
	/\b(?:he|she|my (?:friend|partner|wife|husband|girlfriend|boyfriend|mate|brother|sister|coach|trainer|pt|dad|mum|mom)|someone|somebody|people|everyone|nobody|most people|a lot of people)(?: really| actually| just)? (?:hates?|loves?|likes?|dislikes?|enjoys?|can'?t stand|prefers?)\b/i;
const NEGATED_DISLIKE =
	/\b(?:don'?t|do not|doesn'?t|didn'?t|never|not|wouldn'?t say i) (?:really |actually |even )?(?:hate|hated|dislike|disliked|mind|care about)\b/i;
const NEGATED_LOVE =
	/\b(?:don'?t|do not|didn'?t|not) (?:really |actually )?(?:love|adore)\b|\bwouldn'?t say i (?:really )?(?:love|like|adore|enjoy)\b/i;
/** A view from the past ('I used to hate…', '…last session') is not a lasting preference now. */
const PAST = /\b(?:used to|last (?:session|time|week|workout|month)|yesterday)\b/i;
const NEGATED_LIKE =
	/\b(?:don'?t|do not|didn'?t|did not|never|not|no longer) (?:really |actually |even |much |particularly )?(?:like|liked|enjoy|enjoyed|get on with)\b|\bnot (?:a|the|much of a|a big|a huge) fan\b|\bno fan of\b/i;
const SITUATIONAL =
	/\b(?:taken|busy|occupied|in use|being used|unavailable|not available|isn'?t available|out of order|broken|closed|missing|crowded|packed|hogging|queue|waiting|today|tonight|this (?:session|workout|time|morning|evening|afternoon|week)|right now|at the moment|for now|just now|short on time|no time|in a rush|travel(?:l)?ing|hotel|away from home|(?:gym|hotel) (?:doesn'?t|does not|don'?t) have|don'?t have (?:access|a|an|the)|can'?t (?:get|use|reach|find)|someone'?s (?:on|using)|(?:no|isn'?t a|there'?s no) (?:free )?(?:machine|bench|rack|cable|bar|barbell|dumbbells?|plates|space|room)|pain|painful|hurts?|hurting|injur(?:y|ed)|sore|tired(?! of)|exhausted|knackered|(?:i'?m|i am|feeling) (?:sick|ill|unwell)(?! of))\b/i;
const DISLIKE =
	/\b(?:hate|hates|hated|dislike|dislikes|disliked|can'?t stand|cannot stand|detest|loathe|despise|can do without|could do without|sick of|tired of|fed up with|rather not|never (?:want|again|give me|prescribe|program|programme|put|schedule|include)|(?:stop|quit) (?:prescribing|programming|programing|giving me|putting|adding|including|scheduling)|(?:don'?t|do not) (?:ever )?(?:prescribe|program|programme|give me|put|schedule|include)|no more|(?:is|are) the worst|sucks?|(?:is|are) (?:awful|terrible|horrible|miserable|rubbish))\b/i;
const LIKE =
	/\b(?:i|i really|i do|i actually|i quite|i genuinely)(?: really)? (?:like|love|enjoy|adore)\b|^(?:(?:and|but|or|so|plus) )?(?:really )?(?:love|loving|enjoy|enjoying)\b|\b(?:my|an all-time) (?:favourite|favorite)\b|\b(?:big|huge) fan of\b|\bi'?m (?:a )?fan of\b|\b(?:keep|more) (?:prescribing|programming|giving me)\b/i;
const COMPARISON = /\b(?:more than|better than|over|instead of|rather than|than|compared to)\b/i;
const PRONOUN = /\b(?:it|them|they|those|these|that one|this one|that exercise|those exercises)\b/i;
/** A clause that is only names in a list ('…, lunges and deadlifts') says what the one before says. */
const ONLY_NAMES = /^(?:[\s,;:.!]|\b(?:and|or|plus|the|my|also|too)\b|exercise)*$/i;
const MASK = 'exercise';

interface Mention {
	exercise: string;
	start: number;
	end: number;
}

interface Statement {
	exercise: string;
	kind: Exclude<StatementKind, 'none'>;
	quote: string;
}

/** What one clause says, its exercise names masked. */
function clauseKind(text: string): StatementKind {
	if (HYPOTHETICAL.test(text) || SOMEONE_ELSE.test(text)) return 'none';
	if (SITUATIONAL.test(text)) return 'situational';
	if (PAST.test(text)) return 'none';
	if (NEGATED_DISLIKE.test(text) || NEGATED_LOVE.test(text)) return 'none';
	if (NEGATED_LIKE.test(text) || DISLIKE.test(text)) return 'dislike';
	if (LIKE.test(text)) return 'like';
	return 'none';
}

/** Every exercise the sentence names, leftmost and longest first, never overlapping. */
function mentionsIn<C>(
	sentence: TextSpan,
	candidates: readonly C[],
	match: ExerciseMatcher<C>
): Mention[] {
	const words = [...sentence.text.matchAll(/[\p{L}\p{N}&][\p{L}\p{N}'’&-]*/gu)].map((m) => ({
		start: m.index,
		end: m.index + m[0].length
	}));
	const found: Mention[] = [];
	for (let i = 0; i < words.length; i += 1) {
		for (let n = Math.min(MAX_NAME_WORDS, words.length - i); n >= 1; n -= 1) {
			const start = words[i]?.start ?? 0;
			const end = words[i + n - 1]?.end ?? 0;
			const exercise = match(sentence.text.slice(start, end), candidates);
			if (exercise === null) continue;
			found.push({ exercise, start, end });
			i += n - 1;
			break;
		}
	}
	return found;
}

/** The clauses of a sentence, never cut inside an exercise's name ('clean and jerk'). */
function clausesOf(sentence: TextSpan, mentions: readonly Mention[]): TextSpan[] {
	const clauses: TextSpan[] = [];
	for (const clause of splitClauses(sentence.text)) {
		const last = clauses.at(-1);
		const cutsName = mentions.some((m) => m.start < clause.start && m.end > clause.start);
		if (last && cutsName) {
			const end = clause.end;
			clauses[clauses.length - 1] = {
				start: last.start,
				end,
				text: sentence.text.slice(last.start, end)
			};
		} else clauses.push(clause);
	}
	return clauses;
}

/** The clause's text with each exercise name replaced, so a name never reads as a cue. */
function masked(clause: TextSpan, mentions: readonly Mention[], sentence: string): string {
	let text = '';
	let at = clause.start;
	for (const m of mentions) {
		text += `${sentence.slice(at, m.start)}${MASK}`;
		at = m.end;
	}
	return (text + sentence.slice(at, clause.end)).replace(/[‘’ʼ]/g, "'");
}

/** What each exercise in one sentence is stated to be, and the exercises it names. */
function readSentence<C>(
	sentence: TextSpan,
	candidates: readonly C[],
	match: ExerciseMatcher<C>
): {
	statements: Map<string, StatementKind>;
	mentions: Mention[];
	carried: Statement['kind'] | null;
} {
	const mentions = mentionsIn(sentence, candidates, match);
	const question = QUESTION.test(sentence.text);
	const statements = new Map<string, StatementKind>(mentions.map((m) => [m.exercise, 'none']));
	const kinds = new Map<string, Set<StatementKind>>();
	const add = (exercise: string, kind: StatementKind) => {
		if (!kinds.has(exercise)) kinds.set(exercise, new Set());
		kinds.get(exercise)?.add(kind);
	};
	let situationalSentence = false;
	let previous: Mention[] = [];
	let previousKind: StatementKind = 'none';
	let carried: Statement['kind'] | null = null;
	for (const clause of clausesOf(sentence, mentions)) {
		const own = mentions.filter((m) => m.start >= clause.start && m.end <= clause.end);
		const text = masked(clause, own, sentence.text);
		let kind = clauseKind(text);
		if (question && kind !== 'situational') kind = 'none';
		if (own.length > 0 && kind === 'none' && ONLY_NAMES.test(text)) kind = previousKind;
		if (own.length > 0) {
			const comparison = kind === 'situational' ? -1 : text.search(COMPARISON);
			let offset = clause.start;
			for (const m of own) {
				// A name's place in the masked text: names before it were replaced by MASK.
				const at = m.start - offset;
				add(m.exercise, comparison >= 0 && at > comparison ? 'none' : kind);
				offset += m.end - m.start - MASK.length;
			}
			previous = own;
			previousKind = kind;
		} else if (kind === 'situational') {
			situationalSentence = true;
			carried = kind;
		} else if (kind !== 'none' && PRONOUN.test(text)) {
			for (const m of previous) add(m.exercise, kind);
			if (previous.length === 0) carried = kind;
		}
	}
	for (const [exercise, set] of kinds) {
		let kind: StatementKind = 'none';
		if (situationalSentence || set.has('situational')) kind = 'situational';
		else if (set.has('dislike') && set.has('like')) kind = 'none';
		else if (set.has('dislike')) kind = 'dislike';
		else if (set.has('like')) kind = 'like';
		statements.set(exercise, kind);
	}
	// A sentence that names nothing speaks, through a pronoun, of the last exercises named.
	const pronoun = mentions.length === 0 && PRONOUN.test(sentence.text);
	return { statements, mentions, carried: pronoun && !question ? carried : null };
}

/**
 * What the owner's text states about each exercise it names, in the order they are first named.
 * An exercise the matcher does not know is not in the result; one named without a statement is
 * 'none'. See the module comment for the rule.
 */
export function classifyExerciseStatement<C>(
	text: string,
	candidates: readonly C[],
	match: ExerciseMatcher<C>
): ExerciseStatement[] {
	const order: string[] = [];
	const firstQuote = new Map<string, string>();
	const found: Statement[] = [];
	let named: Mention[] = [];
	let namedIn: TextSpan | null = null;
	for (const sentence of splitSentences(text)) {
		const read = readSentence(sentence, candidates, match);
		for (const [exercise, kind] of read.statements) {
			if (!firstQuote.has(exercise)) {
				order.push(exercise);
				firstQuote.set(exercise, sentence.text);
			}
			if (kind !== 'none') found.push({ exercise, kind, quote: sentence.text });
		}
		if (read.carried && namedIn) {
			const quote = text.slice(namedIn.start, sentence.end);
			for (const m of named) found.push({ exercise: m.exercise, kind: read.carried, quote });
		}
		if (read.mentions.length > 0) {
			named = read.mentions;
			namedIn = sentence;
		}
	}
	return order.map((exercise) => {
		const said = found.filter((s) => s.exercise === exercise);
		const dislike = said.find((s) => s.kind === 'dislike');
		const like = said.find((s) => s.kind === 'like');
		const situational = said.find((s) => s.kind === 'situational');
		const quote = firstQuote.get(exercise) ?? '';
		if (dislike && like) return { exercise, kind: 'none', quote };
		const decided = dislike ?? like ?? situational;
		return decided
			? { exercise, kind: decided.kind, quote: decided.quote }
			: { exercise, kind: 'none', quote };
	});
}
