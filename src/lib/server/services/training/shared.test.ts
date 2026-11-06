import { describe, expect, it } from 'vitest';
import { customExerciseSchema } from '../../../domain/training/schemas';
import {
	ConflictError,
	parseWith,
	ProgramConflictError,
	resolveDeps,
	TrainingInputError,
	TrainingNotFoundError,
	type TrainingDeps
} from './shared';

const exercise = {
	name: 'Sandbag shouldering',
	pattern: 'hinge',
	primaryMuscles: ['glutes'],
	measure: 'reps',
	loadType: 'external'
};

describe('the training services’ shared plumbing', () => {
	it('parses with a domain schema, or throws the field errors by dotted path', () => {
		expect(parseWith(customExerciseSchema, exercise)).toMatchObject({ ...exercise, aliases: [] });

		const refused = (() => {
			try {
				parseWith(customExerciseSchema, { ...exercise, aliases: ['Sandbag', ' '] });
			} catch (error) {
				return error;
			}
		})();
		expect(refused).toBeInstanceOf(TrainingInputError);
		expect(refused).toMatchObject({
			name: 'TrainingInputError',
			errors: { 'aliases.1': 'Required' },
			message: 'invalid training input: aliases.1'
		});
	});

	it('makes every conflict a ConflictError, so a form maps any of them by its reason', () => {
		const conflict = new ProgramConflictError();
		expect(conflict).toBeInstanceOf(ConflictError);
		expect(conflict).toBeInstanceOf(Error);
		expect(conflict).toMatchObject({ name: 'ProgramConflictError', reason: 'version' });
	});

	it('names what was not found', () => {
		expect(new TrainingNotFoundError('exercise')).toMatchObject({
			name: 'TrainingNotFoundError',
			message: 'exercise not found'
		});
	});

	it('acts for the owner, now, unless told otherwise', () => {
		const db = {} as NonNullable<TrainingDeps['db']>;
		const before = Date.now();
		const deps = resolveDeps({ db });
		expect(deps).toMatchObject({ db, source: 'owner' });
		expect(deps.now().getTime()).toBeGreaterThanOrEqual(before);

		const at = () => new Date('2026-11-06T07:00:00Z');
		expect(resolveDeps({ db, now: at, source: 'coach' })).toEqual({ db, now: at, source: 'coach' });
	});
});
