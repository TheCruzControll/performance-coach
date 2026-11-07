import { describe, expect, it } from 'vitest';
import { validate } from '../validation';
import {
	adjustDetailsSchema,
	adjustRunSegmentSchema,
	adjustSetSchema,
	moveSessionSchema,
	REASON_MAX,
	skipSessionSchema,
	swapSchema
} from './edits';

const LINEAGE = 'a1b2c3d4-0000-4000-8000-000000000001';

describe('moveSessionSchema', () => {
	it('takes a session, a day and, optionally, a time of day and a reason', () => {
		expect(validate(moveSessionSchema, { sessionLineage: LINEAGE, toDate: '2026-11-11' })).toEqual({
			ok: true,
			data: { sessionLineage: LINEAGE, toDate: '2026-11-11' }
		});
		expect(
			validate(moveSessionSchema, {
				sessionLineage: LINEAGE,
				toDate: '2026-11-11',
				timeOfDay: null,
				reason: '  Work trip  ',
				extra: 'dropped'
			})
		).toEqual({
			ok: true,
			data: { sessionLineage: LINEAGE, toDate: '2026-11-11', timeOfDay: null, reason: 'Work trip' }
		});
	});

	it('names each field it refuses', () => {
		expect(
			validate(moveSessionSchema, {
				sessionLineage: 'lower-a',
				toDate: '2026-11-31',
				timeOfDay: 'dawn',
				reason: 'x'.repeat(REASON_MAX + 1)
			})
		).toEqual({
			ok: false,
			errors: {
				sessionLineage: 'Unknown session',
				toDate: 'Pick a day',
				timeOfDay: 'Pick a time',
				reason: `Up to ${REASON_MAX} characters`
			}
		});
		expect(validate(moveSessionSchema, {})).toMatchObject({
			ok: false,
			errors: { sessionLineage: 'Unknown session', toDate: 'Pick a day' }
		});
	});
});

describe('skipSessionSchema', () => {
	it('takes a session and an optional reason, kept to REASON_MAX characters once trimmed', () => {
		const reason = ` ${'x'.repeat(REASON_MAX)} `;
		expect(validate(skipSessionSchema, { sessionLineage: LINEAGE, reason })).toEqual({
			ok: true,
			data: { sessionLineage: LINEAGE, reason: 'x'.repeat(REASON_MAX) }
		});
		expect(validate(skipSessionSchema, { sessionLineage: LINEAGE, reason: 3 })).toEqual({
			ok: false,
			errors: { reason: 'Write a reason, or leave it blank' }
		});
	});
});

const EXERCISE = 'a1b2c3d4-0000-4000-8000-000000000002';

describe('swapSchema', () => {
	it('takes a planned exercise, its alternative and the scope', () => {
		const swap = {
			sessionLineage: LINEAGE,
			plannedExerciseLineage: EXERCISE,
			toExerciseId: EXERCISE,
			scope: 'never_again'
		};
		expect(validate(swapSchema, swap)).toEqual({ ok: true, data: swap });
		expect(
			validate(swapSchema, { ...swap, toExerciseId: 'goblet_squat', scope: 'always' })
		).toEqual({
			ok: false,
			errors: {
				toExerciseId: 'Pick an alternative',
				scope: 'This session only, or never again?'
			}
		});
	});
});

describe('the adjust schemas', () => {
	it('keep only the fields given, each with its prescription field’s rule', () => {
		const at = { sessionLineage: LINEAGE, plannedExerciseLineage: EXERCISE, position: 1 };
		expect(validate(adjustSetSchema, { ...at, targetRpe: 8.5, restSeconds: null })).toEqual({
			ok: true,
			data: { ...at, targetRpe: 8.5, restSeconds: null }
		});
		expect(validate(adjustSetSchema, { ...at, position: 0, targetRpe: 11, sets: 21 })).toEqual({
			ok: false,
			errors: {
				position: 'Unknown set',
				targetRpe: 'RPE 5 to 10, in half steps',
				sets: 'Between 1 and 20 sets'
			}
		});
		expect(
			validate(adjustRunSegmentSchema, { sessionLineage: LINEAGE, position: 2, hrZone: 6 })
		).toEqual({ ok: false, errors: { hrZone: 'Heart-rate zone 1 to 5' } });
		expect(validate(adjustDetailsSchema, { sessionLineage: LINEAGE, durationMinutes: 5 })).toEqual({
			ok: false,
			errors: { durationMinutes: 'Between 10 and 300 minutes' }
		});
	});
});
