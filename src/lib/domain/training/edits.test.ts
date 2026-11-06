import { describe, expect, it } from 'vitest';
import { validate } from '../validation';
import { moveSessionSchema, REASON_MAX, skipSessionSchema } from './edits';

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
