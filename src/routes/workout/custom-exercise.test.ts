import { describe, expect, it } from 'vitest';
import type { CustomExercise } from '#lib/domain/training/types.ts';
import type { LibraryExercise } from '#lib/domain/workout/index.ts';
import { validate } from '#lib/domain/validation.ts';
import { customExerciseSchema } from '#lib/domain/training/schemas.ts';
import {
	checkDraft,
	DEFAULT_BOUT_SECONDS,
	draftFor,
	draftOf,
	PATTERN_MUSCLES,
	type CustomDraft
} from './custom-exercise.ts';

const listed = (id: string, name: string, key: string | null, aliases: string[] = []) =>
	({
		id,
		key,
		name,
		aliases,
		measure: 'reps',
		loadType: 'external',
		unilateral: false,
		pattern: 'squat',
		equipment: [],
		tags: [],
		defaultSeconds: null,
		restClass: 'compound',
		increment: 2.5
	}) satisfies LibraryExercise;

const LIBRARY = [
	listed('c1', 'Back squat', 'back_squat', ['Barbell back squat']),
	listed('c2', 'Romanian deadlift', 'romanian_deadlift', ['RDL']),
	listed('o1', 'Landmine press', null)
];

const filled = (draft: Partial<CustomDraft> = {}): CustomDraft => ({
	...draftFor({ pattern: 'hinge' }),
	name: 'Sandbag shouldering',
	measure: 'reps',
	loadType: 'external',
	...draft
});

describe('draftFor', () => {
	it('starts from the exercise being replaced: its pattern, the pattern’s muscles, its bout', () => {
		expect(draftFor({ pattern: 'olympic', defaultSeconds: 45 })).toEqual({
			name: '',
			measure: null,
			loadType: null,
			seconds: 45,
			pattern: 'olympic',
			muscles: ['glutes', 'quads'],
			equipment: []
		});
	});

	it('with nothing replaced, asks the pattern and starts a bout at the default', () => {
		const draft = draftFor(null);
		expect(draft).toMatchObject({ pattern: null, muscles: [], seconds: DEFAULT_BOUT_SECONDS });
		expect(DEFAULT_BOUT_SECONDS).toBe(30);
	});

	it('names muscles for every pattern but isolation, whose muscle the owner names', () => {
		for (const [pattern, muscles] of Object.entries(PATTERN_MUSCLES)) {
			expect(muscles.length > 0, pattern).toBe(pattern !== 'isolation');
		}
	});
});

describe('checkDraft', () => {
	it('builds a payload the server’s schema takes, with plain defaults for the rest', () => {
		const checked = checkDraft(filled({ name: '  Sandbag   shouldering ' }), LIBRARY);
		if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
		expect(checked.exercise).toMatchObject({
			name: 'Sandbag shouldering',
			measure: 'reps',
			loadType: 'external',
			pattern: 'hinge',
			primaryMuscles: ['glutes', 'hamstrings'],
			defaultSeconds: null,
			equipment: []
		});
		expect(validate(customExerciseSchema, checked.exercise)).toEqual({
			ok: true,
			data: checked.exercise
		});
	});

	it('asks the name and the two choices, and the pattern when nothing gave one', () => {
		expect(checkDraft({ ...draftFor(null) }, LIBRARY)).toEqual({
			ok: false,
			errors: {
				name: 'Name it',
				measure: 'Reps, time or distance?',
				loadType: 'Pick how it is loaded',
				pattern: 'Pick a movement pattern',
				primaryMuscles: 'Pick a muscle'
			}
		});
	});

	it('keeps a time-measured exercise’s bout, and asks for one within an hour', () => {
		const timed = checkDraft(filled({ measure: 'time', seconds: 40 }), LIBRARY);
		expect(timed.ok && timed.exercise.defaultSeconds).toBe(40);
		expect(timed.ok && validate(customExerciseSchema, timed.exercise).ok).toBe(true);
		for (const seconds of [null, 0, 3601, 2.5]) {
			const checked = checkDraft(filled({ measure: 'time', seconds }), LIBRARY);
			expect(checked.ok ? null : checked.errors.defaultSeconds, String(seconds)).toMatch(
				/How long is one bout or hold/
			);
		}
		// Only a time-measured exercise has one.
		const reps = checkDraft(filled({ seconds: 40 }), LIBRARY);
		expect(reps.ok && reps.exercise.defaultSeconds).toBeNull();
	});

	it('refuses a catalogue name or alias, and one of the owner’s, as the server words it', () => {
		const nameError = (name: string) => {
			const checked = checkDraft(filled({ name }), LIBRARY);
			return checked.ok ? null : (checked.errors.name ?? null);
		};
		expect(nameError('Back squat')).toBe('Already in the library as Back squat');
		expect(nameError('back-squats')).toBe('Already in the library as Back squat');
		expect(nameError('RDL')).toBe('Already in the library as Romanian deadlift');
		expect(nameError('Landmine Press')).toBe('You already have Landmine press');
		expect(nameError('Sandbag shouldering')).toBeNull();
		expect(nameError('x'.repeat(81))).toBe('Up to 80 characters');
	});

	it('asks for at most six main muscles', () => {
		const muscles = ['quads', 'glutes', 'hamstrings', 'calves', 'abs', 'obliques', 'lats'] as const;
		const checked = checkDraft(filled({ muscles: [...muscles] }), LIBRARY);
		expect(checked.ok ? null : checked.errors.primaryMuscles).toBe('Up to 6 main muscles');
	});

	it('Fix: keeps the refused exercise’s other fields and does not clash with itself', () => {
		const refused: CustomExercise = {
			...(checkDraft(filled(), LIBRARY) as { exercise: CustomExercise }).exercise,
			name: 'Landmine press',
			aliases: ['Sandbag to shoulder'],
			secondaryMuscles: ['glutes', 'lower_back'],
			unilateral: true
		};
		const draft = draftOf(refused);
		expect(draft).toMatchObject({ name: 'Landmine press', pattern: 'hinge', measure: 'reps' });
		// The cached library already lists it under its own id: no clash with itself.
		const self = checkDraft(draft, LIBRARY, { base: refused, except: 'o1' });
		expect(self.ok).toBe(true);

		const renamed = checkDraft({ ...draft, name: 'Sandbag load', muscles: ['glutes'] }, LIBRARY, {
			base: refused,
			except: 'o1'
		});
		if (!renamed.ok) throw new Error(JSON.stringify(renamed.errors));
		expect(renamed.exercise).toMatchObject({
			name: 'Sandbag load',
			aliases: ['Sandbag to shoulder'],
			unilateral: true,
			primaryMuscles: ['glutes'],
			// A muscle is primary or secondary, never both.
			secondaryMuscles: ['lower_back']
		});
	});
});
