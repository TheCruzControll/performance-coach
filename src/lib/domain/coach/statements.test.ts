import { describe, expect, it } from 'vitest';
import {
	classifyExerciseStatement,
	MAX_NAME_WORDS,
	STATEMENT_KINDS,
	type ExerciseStatement,
	type StatementKind
} from './statements';

interface Entry {
	key: string;
	name: string;
	aliases: string[];
}

/** A small library, and a matcher shaped like M3's: whole names or aliases, plurals ignored. */
const LIBRARY: Entry[] = [
	{ key: 'leg_press', name: 'Leg press', aliases: [] },
	{ key: 'bss', name: 'Bulgarian split squat', aliases: ['BSS'] },
	{ key: 'back_squat', name: 'Back squat', aliases: ['Squat'] },
	{ key: 'lunge', name: 'Lunge', aliases: [] },
	{ key: 'clean_and_jerk', name: 'Clean and jerk', aliases: [] },
	{ key: 'deadlift', name: 'Deadlift', aliases: [] },
	{ key: 'bench_press', name: 'Bench press', aliases: ['Bench'] },
	{ key: 'good_morning', name: 'Good morning', aliases: [] },
	{ key: 'pull_up', name: 'Pull-up', aliases: [] },
	{ key: 'hip_thrust', name: 'Hip thrust', aliases: [] },
	{ key: 'box_jump', name: 'Box jump', aliases: [] }
];

const normal = (text: string) =>
	text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean)
		.map((w) => (w.length > 2 && w.endsWith('s') ? w.slice(0, -1) : w))
		.join('');

function match(text: string, library: readonly Entry[]): string | null {
	const n = normal(text);
	return library.find((e) => [e.name, ...e.aliases].some((t) => normal(t) === n))?.key ?? null;
}

const classify = (text: string) => classifyExerciseStatement(text, LIBRARY, match);
const kinds = (text: string) =>
	Object.fromEntries(classify(text).map((s) => [s.exercise, s.kind])) as Record<
		string,
		StatementKind
	>;

const CASES: [string, Record<string, StatementKind>][] = [
	// Dislikes
	['I hate Bulgarian split squats', { bss: 'dislike' }],
	['I really dislike lunges.', { lunge: 'dislike' }],
	["I can't stand the leg press", { leg_press: 'dislike' }],
	['Not a fan of good mornings.', { good_morning: 'dislike' }],
	["I don't like deadlifts", { deadlift: 'dislike' }],
	['Please never give me lunges again.', { lunge: 'dislike' }],
	['Stop programming hip thrusts.', { hip_thrust: 'dislike' }],
	['No more box jumps, please.', { box_jump: 'dislike' }],
	["I'm sick of bench press", { bench_press: 'dislike' }],
	['Lunges are the worst.', { lunge: 'dislike' }],
	['I’d rather not do pull-ups', { pull_up: 'dislike' }],
	['I never liked squats', { back_squat: 'dislike' }],
	// Likes
	['I love deadlifts', { deadlift: 'like' }],
	['I really like the bench press', { bench_press: 'like' }],
	['Squats are my favourite.', { back_squat: 'like' }],
	['Love box jumps!', { box_jump: 'like' }],
	["I'm a big fan of hip thrusts", { hip_thrust: 'like' }],
	['Keep programming pull-ups', { pull_up: 'like' }],
	// Situational
	['The leg press is taken', { leg_press: 'situational' }],
	["Someone's on the bench, so I'll skip it", { bench_press: 'situational' }],
	['No free rack for squats right now', { back_squat: 'situational' }],
	['I hate that the leg press is busy today', { leg_press: 'situational' }],
	["I don't feel like lunges today", { lunge: 'situational' }],
	['The rack is broken, can I swap squats?', { back_squat: 'situational' }],
	["I'm travelling this week, so no deadlifts", { deadlift: 'situational' }],
	['My knee hurts on lunges', { lunge: 'situational' }],
	['Lunges hurt my knee', { lunge: 'situational' }],
	['I hate good mornings this morning', { good_morning: 'situational' }],
	// Mixed
	['I love squats but hate lunges', { back_squat: 'like', lunge: 'dislike' }],
	['The leg press is taken, but I love squats', { leg_press: 'situational', back_squat: 'like' }],
	['I hate lunges, at least today', { lunge: 'situational' }],
	['I hate lunges more than squats', { lunge: 'dislike', back_squat: 'none' }],
	['I prefer squats over lunges', { back_squat: 'none', lunge: 'none' }],
	['I hate lunges. Never give me them again.', { lunge: 'dislike' }],
	["I hate the leg press. It's taken anyway.", { leg_press: 'dislike' }],
	['The leg press is taken. I hate it anyway.', { leg_press: 'dislike' }],
	['I love squats, lunges and deadlifts', { back_squat: 'like', lunge: 'like', deadlift: 'like' }],
	['Clean and jerk is my favourite', { clean_and_jerk: 'like' }],
	['I love lunges. I hate lunges.', { lunge: 'none' }],
	['People love hip thrusts but I hate them', { hip_thrust: 'dislike' }],
	// Negation and nothing stated
	["I don't mind lunges", { lunge: 'none' }],
	["I don't hate the leg press", { leg_press: 'none' }],
	["I don't hate lunges, I love them", { lunge: 'like' }],
	["I don't love deadlifts", { deadlift: 'none' }],
	['I used to hate squats, now they are fine', { back_squat: 'none' }],
	['I hated the leg press last session', { leg_press: 'none' }],
	["I wouldn't say I love lunges", { lunge: 'none' }],
	['Do you think I like squats?', { back_squat: 'none' }],
	['If I hated deadlifts, what would you swap?', { deadlift: 'none' }],
	['My partner hates lunges', { lunge: 'none' }],
	['How are my squats going?', { back_squat: 'none' }],
	// Names the matcher does not know
	['I hate zercher carries', {}],
	['I hate cardio', {}],
	['I hate Zercher carries but love deadlifts', { deadlift: 'like' }],
	['', {}]
];

describe('classifyExerciseStatement', () => {
	it(`classifies ${CASES.length} phrasings: dislikes, likes, situations, mixes, negations, unknown names`, () => {
		expect(CASES.length).toBeGreaterThanOrEqual(40);
		for (const [text, expected] of CASES) expect(kinds(text), text).toEqual(expected);
	});

	it('quotes the owner’s words that decided it, as written', () => {
		expect(classify('Hi coach. I hate Bulgarian split squats! What else is there?')).toEqual([
			{ exercise: 'bss', kind: 'dislike', quote: 'I hate Bulgarian split squats!' }
		] satisfies ExerciseStatement[]);
		expect(classify('The leg press is taken. I hate it anyway.')).toEqual([
			{ exercise: 'leg_press', kind: 'dislike', quote: 'The leg press is taken. I hate it anyway.' }
		]);
		expect(classify('How are squats going?')).toEqual([
			{ exercise: 'back_squat', kind: 'none', quote: 'How are squats going?' }
		]);
	});

	it('lists each exercise once, in the order first named', () => {
		expect(
			classify('I love squats. Lunges are the worst. Squats again!').map((s) => s.exercise)
		).toEqual(['back_squat', 'lunge']);
	});

	it('only ever returns its four kinds', () => {
		for (const [text] of CASES) {
			for (const s of classify(text)) expect(STATEMENT_KINDS).toContain(s.kind);
		}
	});

	it('asks the injected matcher about runs of up to MAX_NAME_WORDS words, and nothing else', () => {
		const asked: string[] = [];
		const spy = (text: string, library: readonly Entry[]) => {
			expect(library).toBe(LIBRARY);
			asked.push(text);
			return match(text, library);
		};
		classifyExerciseStatement('one two three four five six seven eight', LIBRARY, spy);
		expect(MAX_NAME_WORDS).toBe(6);
		expect(asked).toContain('one two three four five six');
		expect(asked.every((t) => t.split(' ').length <= MAX_NAME_WORDS)).toBe(true);
		expect(asked).not.toContain('one two three four five six seven');
	});

	it('trusts the matcher alone: a name it does not know is never classified', () => {
		const none = () => null;
		expect(classifyExerciseStatement('I hate Bulgarian split squats', LIBRARY, none)).toEqual([]);
	});

	it("never lets an exercise's name read as a cue", () => {
		const library = [{ key: 'today_press', name: 'Today press', aliases: [] }];
		expect(classifyExerciseStatement('I hate the today press', library, match)).toEqual([
			{ exercise: 'today_press', kind: 'dislike', quote: 'I hate the today press' }
		]);
	});
});
