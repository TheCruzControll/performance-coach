import { describe, expect, it } from 'vitest';
import {
	baselineEntrySchema,
	bodySchema,
	goalSchema,
	injurySchema,
	raceResultSchema,
	validate
} from './schemas';

/** Each optional date with a valid record around it, so only the date decides the outcome. */
const OPTIONAL_DATES = [
	{
		name: 'general goal target date',
		schema: goalSchema,
		field: 'targetDate',
		record: {
			kind: 'general',
			title: 'Keep my strength',
			disciplines: ['strength'],
			focus: 'Hold squat and deadlift while fight camp runs',
			measure: 'Top sets at RPE 8 stay within 5%'
		}
	},
	{
		name: '1RM date',
		schema: baselineEntrySchema,
		field: 'achievedOn',
		record: { lift: 'back_squat', source: 'tested', value: 140, unit: 'kg' }
	},
	{
		name: 'race date',
		schema: raceResultSchema,
		field: 'racedOn',
		record: { distance: '10k', timeSeconds: 2700 }
	},
	{
		name: 'injury “since”',
		schema: injurySchema,
		field: 'since',
		record: { bodyArea: 'knee', side: null, severity: 'mild', avoid: [], active: true }
	},
	{
		name: 'body target date',
		schema: bodySchema,
		field: 'targetDate',
		record: { weightUnit: 'kg', nutritionPhase: 'cut', targetWeight: 71 }
	}
] as const;

describe('optional dates', () => {
	describe.each(OPTIONAL_DATES)('$name', ({ schema, field, record }) => {
		it.each(['', null, undefined])('treats %j as no date', (blank) => {
			const result = validate(schema, { ...record, [field]: blank });
			expect(result).toMatchObject({ ok: true, data: { [field]: null } });
		});

		it('keeps a real date', () => {
			const result = validate(schema, { ...record, [field]: '2026-09-01' });
			expect(result).toMatchObject({ ok: true, data: { [field]: '2026-09-01' } });
		});

		it.each(['2027-02-30', '1899-12-31', '2026-9-1', 20260901])('refuses %j', (date) => {
			expect(validate(schema, { ...record, [field]: date })).toEqual({
				ok: false,
				errors: { [field]: 'Use a real date' }
			});
		});
	});
});

describe('required dates', () => {
	it('still needs the event date of an event goal', () => {
		const event = {
			kind: 'event',
			title: 'First Muay Thai fight',
			disciplines: ['muay_thai'],
			eventType: 'Muay Thai fight'
		};
		for (const eventDate of ['', null, undefined, '2027-02-30']) {
			expect(validate(goalSchema, { ...event, eventDate })).toEqual({
				ok: false,
				errors: { eventDate: 'Pick the event date' }
			});
		}
		expect(validate(goalSchema, { ...event, eventDate: '2027-03-14' })).toMatchObject({
			ok: true,
			data: { eventDate: '2027-03-14' }
		});
	});
});
