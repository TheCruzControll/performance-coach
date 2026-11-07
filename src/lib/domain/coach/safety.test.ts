import { describe, expect, it } from 'vitest';
import { BODY_AREAS } from '../profile/catalog';
import { PAIN_COPY } from '../workout/copy';
import {
	ALWAYS_BANNED,
	DIAGNOSIS_PATTERNS,
	GENERIC_GENTLER,
	MAX_GENTLER,
	MAX_PATTERN_CHARS,
	PAIN_CONTEXT_PHRASES,
	PAIN_WORDS,
	detectPain,
	hasContextPhrase,
	hasPainWord,
	safeGuidance,
	scanAdvice,
	scanForm,
	type AdvicePattern
} from './safety';

/**
 * The longest text a regex source can match, counting a lookahead's reach as matched text (so the
 * bound covers what the gate must hold to decide it). Throws on `*`, `+`, an open `{n,}`, a
 * backreference, a lookbehind or a named group, none of which a bounded pattern may use.
 */
function maxLength(source: string): number {
	let i = 0;
	const fail = (why: string): never => {
		throw new Error(`${why} at ${i} in /${source}/`);
	};
	const lazy = () => {
		if (source[i] === '?') i += 1;
	};
	function quantify(len: number): number {
		const c = source[i];
		if (c === '*' || c === '+') fail(`unbounded quantifier ${c}`);
		if (c === '?') {
			i += 1;
			lazy();
			return len;
		}
		if (c === '{') {
			const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i));
			if (!m) return len;
			if (m[2] !== undefined && m[3] === '') fail('open quantifier');
			i += m[0].length;
			lazy();
			return len * Number(m[3] ?? m[1]);
		}
		return len;
	}
	function atom(): number {
		const c = source[i];
		if (c === '(') {
			i += 1;
			if (source[i] === '?') {
				const kind = source.slice(i, i + 2);
				if (kind === '?:' || kind === '?=' || kind === '?!') i += 2;
				else fail(`unsupported group (${kind}`);
			}
			const len = alternatives();
			if (source[i] !== ')') fail('unclosed group');
			i += 1;
			return len;
		}
		if (c === '[') {
			i += 1;
			if (source[i] === '^') i += 1;
			if (source[i] === ']') i += 1;
			while (source[i] !== ']') {
				if (i >= source.length) fail('unclosed class');
				i += source[i] === '\\' ? 2 : 1;
			}
			i += 1;
			return 1;
		}
		if (c === '\\') {
			const next = source[i + 1] ?? '';
			i += 2;
			if (next === 'b' || next === 'B') return 0;
			if (/[1-9k]/.test(next)) fail('backreference');
			if (next === 'p' || next === 'P') fail('a \\p class, which needs the u flag');
			return 1;
		}
		if (c === '^' || c === '$') {
			i += 1;
			return 0;
		}
		if (c === '*' || c === '+' || c === '?') fail('quantifier without an atom');
		i += 1;
		return 1;
	}
	function sequence(): number {
		let total = 0;
		while (i < source.length && source[i] !== '|' && source[i] !== ')') total += quantify(atom());
		return total;
	}
	function alternatives(): number {
		let best = sequence();
		while (source[i] === '|') {
			i += 1;
			best = Math.max(best, sequence());
		}
		return best;
	}
	const len = alternatives();
	if (i !== source.length) fail('unbalanced )');
	return len;
}

const ALL_PATTERNS: readonly AdvicePattern[] = [
	...ALWAYS_BANNED,
	...PAIN_CONTEXT_PHRASES,
	...DIAGNOSIS_PATTERNS,
	...PAIN_WORDS
];

describe('the patterns are bounded', () => {
	it('measures what it is given (the measuring stick itself)', () => {
		expect(maxLength('a{2,5}')).toBe(5);
		expect(maxLength('a{3}b?')).toBe(4);
		expect(maxLength('(?:ab|c)?d')).toBe(3);
		expect(maxLength('\\bno pain,? no gain\\b')).toBe(16);
		expect(maxLength('[a-z\\]]{1,15} (?![ -]?free)')).toBe(16 + 5);
		expect(maxLength('x(?:(?:ab){2}|c){0,3}')).toBe(13);
		for (const bad of ['a+', 'a*', 'a{2,}', '(a)\\1', '(?<=a)b', '(?<n>a)', '\\p{L}', 'a)']) {
			expect(() => maxLength(bad), bad).toThrow();
		}
	});

	it('every pattern has only bounded quantifiers, and matches at most MAX_PATTERN_CHARS', () => {
		expect(MAX_PATTERN_CHARS).toBe(80);
		const lengths = ALL_PATTERNS.map(({ id, pattern }) => [id, maxLength(pattern.source)] as const);
		expect(lengths.filter(([, n]) => n > MAX_PATTERN_CHARS)).toEqual([]);
		expect(Math.max(...lengths.map(([, n]) => n))).toBeGreaterThan(40);
	});

	it('every pattern is case-blind, stateless and has its own id', () => {
		for (const { id, pattern } of ALL_PATTERNS) expect(pattern.flags, id).toBe('i');
		const ids = ALL_PATTERNS.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('so a held tail of MAX_PATTERN_CHARS, rescanned with what follows, sees any match whole', () => {
		const filler = 'Brace hard and keep the bar path over your mid-foot as it moves. '.repeat(4);
		const form = scanForm(`${filler}Keep lifting even though a little bit of knee pain stays.`);
		const always = (text: string) =>
			scanAdvice(text, { painContext: false }).some((v) => v.kind === 'always');
		// A gate holding `overlap` characters at each release point `cut`: a match is seen if the text
		// so far holds it whole, or if the held tail, rescanned with all that follows, does.
		const missed = (overlap: number) =>
			Array.from({ length: form.length + 1 }, (_, cut) => cut).filter(
				(cut) => !always(form.slice(0, cut)) && !always(form.slice(Math.max(0, cut - overlap)))
			);
		expect(always(form)).toBe(true);
		expect(missed(MAX_PATTERN_CHARS)).toEqual([]);
		expect(missed(20).length).toBeGreaterThan(0);
	});
});

/** Phrases M4's copy scan bans (domain/workout/copy.test.ts), and its two patterns verbatim. */
const M4_PHRASES = [
	'Push through it',
	'push on',
	'Work through the pain',
	'power through',
	'Tough it out',
	'Keep going!',
	'No pain, no gain',
	'no pain no gain',
	'Ignore the pain',
	'ignore pain',
	'Shake it off',
	'diagnosis',
	'Tendinitis',
	'a tear',
	'sprain',
	'strained',
	'fracture',
	'impingement'
];
const M4_PUSH_THROUGH =
	/push (through|on)|work through|power through|tough it out|keep going|no pain,? no gain|ignore (the )?pain|shake it off/i;
const M4_DIAGNOSIS = /diagnos|tendin|tear|sprain|strain|fracture|impinge/i;

/** Said in any answer, pain or not: each must be caught with no pain context at all. */
const ALWAYS = [
	'Just push through the pain.',
	'You can work through the discomfort for now.',
	'Play through the pain this once.',
	'Power through your knee pain on the last set.',
	'Grind through that twinge.',
	'Train through the injury and see how it feels.',
	'Keep going through the pain.',
	'Keep training with a little pain.',
	'Carry on lifting even though it hurts.',
	'Squat through a bit of soreness.',
	'Fight past the ache.',
	'Lean into the pain.',
	'Keep lifting despite the pain.',
	'Finish strong even if it hurts.',
	'No pain, no gain!',
	'Tough it out.',
	'Suck it up.',
	'Walk it off.',
	'Shake it off and go again.',
	'Man up.',
	'Grit your teeth through it.',
	'Pain is just weakness leaving the body.',
	'A little discomfort is normal here.',
	'Ignore the pain.',
	"Don't worry about the twinge.",
	'Forget about your elbow pain.',
	"It's nothing serious.",
	"It's probably just a niggle.",
	'It sounds like tendinitis.',
	'That could be a tear.',
	'You probably have a minor injury.',
	'Sounds like a rotator cuff injury.',
	"You've strained your hamstring.",
	'It might be a sprain.',
	'Looks like impingement to me.',
	'This is classic runner’s knee.',
	'You may have a stress fracture.',
	'I would diagnose this as bursitis.',
	'Could be sciatica.',
	'That sounds like a pinched nerve.',
	'The tendon is inflamed.',
	'You might have pulled a muscle — you pulled your calf.',
	// Written around the patterns: markdown, hyphens, odd spaces, invisible characters, quotes.
	'Push **through** the pain.',
	'push-through the pain',
	'push   through\n the pain',
	'push\u200b through the pain',
	'Don’t worry about the pain.'
];

/** Fine about a sticking point; banned with pain in the turn or the text. */
const CONTEXT = [
	'Drive through the sticking point.',
	'Push through the last rep.',
	'Push on to the end.',
	'Keep going!',
	'Keep pushing.',
	'Carry on with the session.',
	'Power through it.',
	'Work through the set.',
	"Don't stop now.",
	'Finish the set.',
	'Complete your remaining sets.',
	'One more rep.',
	'Just a few more reps.',
	'Stick with it.',
	'It will ease once you warm up.',
	"It'll loosen up.",
	'Continue as planned.'
];

/** Ordinary gym advice: none of it may be flagged without pain context. */
const SAFE = [
	'Drive through the sticking point and finish the rep.',
	'Push the floor away and keep going until lockout.',
	'Make a small tweak to your setup and keep going.',
	'Work through the warm-up sets before the top set.',
	'Keep your chest up and brace before each rep.',
	'Rest 2–3 minutes between heavy sets.',
	'Add 2.5 kg next week if every rep moved well.',
	'Your squat e1RM rose from 140 to 146 kg over four weeks.',
	'Swap to the pain-free variation: box squats.',
	'Go with the pain-free option today.',
	'Continue with your rest day tomorrow.',
	'Given your time constraints, three sessions fit best.',
	'Keep the bar path close to your shins.',
	'One more set of rows would push weekly volume over 20 sets.',
	'Stopping is always OK.',
	'Choose a lighter variation, or rest that movement today.',
	'If it keeps coming back, add it to Profile → Injuries.',
	'If the pain is sharp or persists, see a doctor or physiotherapist.',
	'Tempo squats teach control at the bottom.',
	'This block builds towards a heavy single in week 6.',
	'Your long run should feel conversational.',
	'Breathe out as you press.',
	'Pause at the bottom for one second.'
];

describe('scanAdvice', () => {
	it(`catches ${ALWAYS.length} banned phrasings with no pain context`, () => {
		expect(ALWAYS.length).toBeGreaterThanOrEqual(30);
		const missed = ALWAYS.filter((s) => scanAdvice(s, { painContext: false }).length === 0);
		expect(missed).toEqual([]);
	});

	it('bans the context phrases only with pain context, or a pain word in the text', () => {
		for (const phrase of CONTEXT) {
			expect(scanAdvice(phrase, { painContext: false }), phrase).toEqual([]);
			expect(hasContextPhrase(phrase), phrase).toBe(true);
			const kinds = scanAdvice(phrase, { painContext: true }).map((v) => v.kind);
			expect(kinds, phrase).toContain('pain_context');
			const withPain = `${phrase} Your knee hurts, I know.`;
			expect(scanAdvice(withPain, { painContext: false }).length, withPain).toBeGreaterThan(0);
		}
	});

	it('reads discomfort, tenderness and a tweak as pain, so carrying on through them is flagged', () => {
		for (const s of [
			'If you feel some discomfort, keep going.',
			'The discomfort will ease as you warm up.',
			'If your knee feels tender, keep going.',
			'Your back is tweaked, but finish the set.'
		]) {
			expect(scanAdvice(s, { painContext: false }).length, s).toBeGreaterThan(0);
		}
	});

	it(`passes ${SAFE.length} safe gym sentences without pain context`, () => {
		expect(SAFE.length).toBeGreaterThanOrEqual(20);
		const flagged = SAFE.filter((s) => scanAdvice(s, { painContext: false }).length > 0);
		expect(flagged).toEqual([]);
		expect(scanAdvice('Drive through the sticking point.', { painContext: false })).toEqual([]);
	});

	it('covers every phrase M4 bans, and whatever of them its patterns flag', () => {
		for (const phrase of [...M4_PHRASES, ...ALWAYS, ...CONTEXT]) {
			const m4 = M4_PUSH_THROUGH.test(phrase) || M4_DIAGNOSIS.test(phrase);
			if (m4 || M4_PHRASES.includes(phrase)) {
				expect(scanAdvice(phrase, { painContext: true }).length, phrase).toBeGreaterThan(0);
			}
		}
	});

	it('names each violation, its kind and where it is in the scan form, in order', () => {
		const text = 'Keep going, ignore the pain — it sounds like tendinitis.';
		const found = scanAdvice(text, { painContext: false });
		expect(found.map((v) => [v.kind, v.id, v.match])).toEqual([
			['pain_context', 'keep_going', 'Keep going'],
			['always', 'ignore_pain', 'ignore the pain'],
			['diagnosis', 'itis', 'tendinitis'],
			['diagnosis', 'tendon_condition', 'tendinitis']
		]);
		const form = scanForm(text);
		for (const v of found) expect(form.slice(v.index, v.index + v.match.length)).toBe(v.match);
	});
});

describe('scanForm, hasPainWord and hasContextPhrase', () => {
	it('collapses spacing and markup, straightens quotes and dashes, drops invisible characters', () => {
		expect(scanForm('Don’t  *push*\n\n_through_ — it\u200b, pain-free')).toBe(
			"Don't push through it, pain free"
		);
	});

	it('hasPainWord is broad: soreness and injuries count, pain-free still names pain', () => {
		for (const s of ['My knee hurts', 'some soreness', 'an old injury', 'achy', 'pain-free']) {
			expect(hasPainWord(s), s).toBe(true);
		}
		for (const s of ['Drive through the sticking point', 'Paint the wall', 'Spain', 'hurtle']) {
			expect(hasPainWord(s), s).toBe(false);
		}
	});

	it('hasContextPhrase finds the phrases however they are written', () => {
		expect(hasContextPhrase('keep **going**')).toBe(true);
		expect(hasContextPhrase('Keep the bar close')).toBe(false);
	});
});

describe('detectPain', () => {
	const cases: [string, ReturnType<typeof detectPain>][] = [
		['My knee hurts when I squat', { reported: true, area: 'knee', severe: false }],
		['Sharp pain in my lower back', { reported: true, area: 'lower_back', severe: true }],
		['My shoulder popped on the bench', { reported: true, area: 'shoulder', severe: true }],
		['My left hand went numb during rows', { reported: true, area: 'wrist_hand', severe: true }],
		['My ankle is swollen', { reported: true, area: 'ankle_foot', severe: true }],
		['There is some swelling around my elbow', { reported: true, area: 'elbow', severe: true }],
		['Pins and needles down my arm', { reported: true, severe: true }],
		['I tweaked my back deadlifting', { reported: true, area: 'lower_back', severe: false }],
		['Back squats hurt my knee', { reported: true, area: 'knee', severe: false }],
		[
			'Hip thrusts are painful on my lower back',
			{ reported: true, area: 'lower_back', severe: false }
		],
		['My knee is sore', { reported: true, area: 'knee', severe: false }],
		['Something feels sharp in my hamstring', { reported: true, area: 'hamstring', severe: true }],
		[
			'No pain in my knee, but my shoulder hurts',
			{ reported: true, area: 'shoulder', severe: false }
		],
		["It doesn't hurt much, just my wrist", { reported: true, area: 'wrist_hand', severe: false }],
		["My knee doesn't hurt, but it's swollen", { reported: true, area: 'knee', severe: true }],
		['I took painkillers for my neck', { reported: true, area: 'neck', severe: false }],
		['It hurts', { reported: true, severe: false }],
		['I sprained my ankle', { reported: true, area: 'ankle_foot', severe: false }],
		['I strained my calf', { reported: true, area: 'shin_calf', severe: false }],
		['I rolled my ankle yesterday', { reported: true, area: 'ankle_foot', severe: false }],
		[
			'I think I pulled something in my back',
			{ reported: true, area: 'lower_back', severe: false }
		],
		['I have tendinitis in my elbow', { reported: true, area: 'elbow', severe: false }],
		['no pain', { reported: false, severe: false }],
		['I am not in pain', { reported: false, severe: false }],
		['Totally pain-free today', { reported: false, severe: false }],
		['I am sore from Monday', { reported: false, severe: false }],
		['My quads are sore after squats', { reported: false, severe: false }],
		['Legs ache from yesterday, DOMS is real', { reported: false, severe: false }],
		["My knee doesn't hurt anymore", { reported: false, severe: false }],
		['The pain is gone', { reported: false, severe: false }],
		['No pain, no gain', { reported: false, severe: false }],
		["It wouldn't hurt to add a set", { reported: false, severe: false }],
		['How did my bench go this week?', { reported: false, severe: false }],
		['Squats felt heavy but fine', { reported: false, severe: false }],
		['Foam rolled my calves', { reported: false, severe: false }],
		['I rolled my shoulders back and it felt better', { reported: false, severe: false }],
		["I'm torn between squats and deadlifts today", { reported: false, severe: false }],
		['I feel the strain in my quads, good workout', { reported: false, severe: false }]
	];

	it(`reads ${cases.length} messages: pain, its area and severity; soreness and denials are not pain`, () => {
		expect(cases.length).toBeGreaterThanOrEqual(25);
		for (const [text, expected] of cases) expect(detectPain(text), text).toEqual(expected);
	});

	it('reads curly apostrophes as straight ones', () => {
		expect(detectPain('My knee doesn’t hurt anymore').reported).toBe(false);
	});
});

describe('safeGuidance', () => {
	const alternativeSets = [
		[],
		[{ id: 'box_squat', name: 'Box squat' }],
		[
			{ id: 'box_squat', name: 'Box squat' },
			{ id: 'leg_press', name: 'Leg press' },
			{ name: 'Wall sit' },
			{ id: 'goblet_squat', name: 'Goblet squat' }
		],
		[
			{ id: 'bad id!', name: 'Spanish squat' },
			{ id: 'x', name: 'Push through the pain squat' },
			{ id: 'y', name: 'Tear-drop curl' },
			{ id: 'z', name: ' [[Split|squat]] ' },
			{ id: 'box_squat', name: 'Box squat' },
			{ id: 'box_squat', name: 'Box squat' }
		],
		[{ id: 'a', name: 'Keep going lunges' }]
	];
	const outputs = [null, ...BODY_AREAS].flatMap((area) =>
		alternativeSets.map((alternatives) => ({
			area,
			alternatives,
			text: safeGuidance({ area, alternatives })
		}))
	);

	it('is always a safety block that passes scanAdvice in pain context', () => {
		for (const { text } of outputs) {
			expect(text.startsWith('[safety] '), text).toBe(true);
			expect(text.slice(1).match(/\[(?!\[|exercise:)/g), text).toBeNull();
			expect(scanAdvice(text, { painContext: true }), text).toEqual([]);
		}
	});

	it('always says stop, offers a gentler option and names a professional, never a diagnosis', () => {
		for (const { text } of outputs) {
			expect(text, text).toMatch(/\bStop the movement that hurts\b/);
			expect(text, text).toMatch(/gentler/i);
			expect(text, text).toContain(PAIN_COPY.professional);
			expect(text, text).toContain('Profile → Injuries');
			expect(
				DIAGNOSIS_PATTERNS.some(({ pattern }) => pattern.test(text)),
				text
			).toBe(false);
		}
	});

	it('names the alternatives as refs, at most MAX_GENTLER, else the generic gentler option', () => {
		expect(safeGuidance({ area: 'knee', alternatives: alternativeSets[2] ?? [] })).toBe(
			'[safety] Stop the movement that hurts; stopping is always OK. Gentler on your knee: ' +
				'[[exercise:box_squat|Box squat]], [[exercise:leg_press|Leg press]] or Wall sit. ' +
				`${PAIN_COPY.professional} If it keeps coming back, add it to Profile → Injuries so your plan works around it.`
		);
		expect(MAX_GENTLER).toBe(3);
		expect(safeGuidance({ area: null, alternatives: [] })).toContain(
			`A gentler option: ${GENERIC_GENTLER}.`
		);
		expect(safeGuidance({ area: 'shoulder', alternatives: [] })).toContain(
			`Gentler on your shoulder: ${GENERIC_GENTLER}.`
		);
	});

	it('leaves out a name that would break the rules, and cites a bad id as plain text', () => {
		const text = safeGuidance({ area: 'knee', alternatives: alternativeSets[3] ?? [] });
		expect(text).toContain(
			'Gentler on your knee: Spanish squat, [[exercise:z|Split squat]] or [[exercise:box_squat|Box squat]].'
		);
		expect(text).not.toMatch(/Push through|Tear-drop/);
		expect(safeGuidance({ area: 'hip', alternatives: alternativeSets[4] ?? [] })).toContain(
			`Gentler on your hip: ${GENERIC_GENTLER}.`
		);
		// Each name passes alone, but together they claim a condition.
		const pair = [{ name: 'That could be a' }, { name: 'leg injury' }];
		expect(safeGuidance({ area: 'knee', alternatives: pair })).toContain(
			`Gentler on your knee: ${GENERIC_GENTLER}.`
		);
	});
});
