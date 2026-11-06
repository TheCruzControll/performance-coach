import { describe, expect, it } from 'vitest';
import { matchExercise, normaliseExerciseName, type MatchableExercise } from './match';

/** A small library, so these cases test the matcher's rules rather than the catalogue's data. */
const LIBRARY: readonly MatchableExercise[] = [
	{ key: 'back_squat', name: 'Back squat', aliases: ['Squat', 'High-bar squat'] },
	{ key: 'romanian_deadlift', name: 'Romanian deadlift', aliases: ['RDL'] },
	{ key: 'bench_press', name: 'Bench press', aliases: [] },
	{ key: 'box_jump', name: 'Box jump', aliases: [] },
	{ key: 'snatch', name: 'Snatch', aliases: [] },
	{ key: 'pull_up', name: 'Pull-up', aliases: [] },
	{ key: 'calf_raise', name: 'Calf raise', aliases: [] },
	{ key: 'dumbbell_fly', name: 'Dumbbell fly', aliases: [] },
	{ key: 'clean_and_jerk', name: 'Clean & jerk', aliases: ['C&J'] },
	{ key: 'worlds_greatest_stretch', name: "World's greatest stretch", aliases: [] },
	{ key: 'plie_squat', name: 'Plié squat', aliases: [] }
];

const match = (text: string) => matchExercise(text, LIBRARY);

describe('matchExercise', () => {
	it.each([
		['the name as written', 'Back squat', 'back_squat'],
		['any case and spacing', '  BACK   squat ', 'back_squat'],
		['hyphens, dots and slashes', 'back-squat.', 'back_squat'],
		['a joined or split compound word', 'Pullup', 'pull_up'],
		['a compound word split by a space', 'pull up', 'pull_up'],
		['an alias', 'RDL', 'romanian_deadlift'],
		['an alias with a hyphen dropped', 'High bar squat', 'back_squat'],
		['& written out as and', 'Clean and jerk', 'clean_and_jerk'],
		['an alias with &', 'c&j', 'clean_and_jerk'],
		['an apostrophe left out', 'Worlds greatest stretch', 'worlds_greatest_stretch'],
		['a curly apostrophe', 'World’s greatest stretch', 'worlds_greatest_stretch'],
		['an accent left out', 'Plie squat', 'plie_squat']
	])('matches %s', (_case, text, key) => {
		expect(match(text)).toBe(key);
	});

	it.each([
		['a plural -s', 'Box jumps', 'box_jump'],
		['a plural on an alias', 'RDLs', 'romanian_deadlift'],
		['a plural on a hyphenated word', 'Pull-ups', 'pull_up'],
		['a plural on a joined word', 'Pullups', 'pull_up'],
		['a plural -es after s', 'Bench presses', 'bench_press'],
		['a plural -es after ch', 'Snatches', 'snatch'],
		['a plural of a word ending in -e', 'Calf raises', 'calf_raise'],
		['a plural -ies', 'Dumbbell flies', 'dumbbell_fly'],
		['a plural of the one-word alias', 'Squats', 'back_squat']
	])('folds %s to the singular', (_case, text, key) => {
		expect(match(text)).toBe(key);
	});

	it('keeps a word that only ends in s, such as press', () => {
		expect(normaliseExerciseName('Bench press')).toBe(normaliseExerciseName('Bench presses'));
		expect(normaliseExerciseName('Press')).toBe('press');
	});

	it.each([
		['an unknown exercise', 'Zercher carry'],
		['part of a name', 'Back'],
		['a name inside a longer text', 'Heavy back squats on Mondays'],
		['two exercises in one text', 'Squats and deadlifts'],
		['an empty text', ''],
		['punctuation alone', ' - / . ']
	])('returns null for %s, never a guess', (_case, text) => {
		expect(match(text)).toBeNull();
	});

	it('returns null for a name two exercises share, and still matches their other names', () => {
		const library: MatchableExercise[] = [
			...LIBRARY,
			{ key: 'front_squat', name: 'Front squat', aliases: ['Squat'] }
		];
		expect(matchExercise('Squats', library)).toBeNull();
		expect(matchExercise('Back squat', library)).toBe('back_squat');
		expect(matchExercise('Front squat', library)).toBe('front_squat');
	});

	it("returns null when an owner's own exercise shares a catalogue name", () => {
		const withCustom = [...LIBRARY, { key: 'custom:5a1d', name: 'Box jumps', aliases: [] }];
		expect(matchExercise('Box jump', withCustom)).toBeNull();
		expect(matchExercise('Bench press', withCustom)).toBe('bench_press');
	});

	it('reads the library it is given each time, never a stale one', () => {
		expect(matchExercise('Box jump', LIBRARY)).toBe('box_jump');
		expect(matchExercise('Box jump', [{ key: 'jump', name: 'Box jump', aliases: [] }])).toBe(
			'jump'
		);
		expect(matchExercise('Box jump', [])).toBeNull();
	});
});
