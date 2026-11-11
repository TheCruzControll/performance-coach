import { describe, expect, it } from 'vitest';
import {
	baselineEntrySchema,
	bodySchema,
	goalSchema,
	heartRateSchema,
	injurySchema,
	raceResultSchema,
	runningSchema,
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

describe('heart rate', () => {
	it('takes any of max, resting and threshold, and turns the missing ones into null', () => {
		expect(validate(heartRateSchema, { resting: 48 })).toEqual({
			ok: true,
			data: { max: null, resting: 48, threshold: null }
		});
		expect(validate(heartRateSchema, { max: 230, resting: 30, threshold: 225 })).toMatchObject({
			ok: true
		});
		expect(validate(heartRateSchema, { max: 120, resting: 110, threshold: 100 })).toEqual({
			ok: false,
			errors: { resting: 'Resting heart rate must be below your threshold' }
		});
	});

	it('names each range, and only orders values that are in range', () => {
		expect(validate(heartRateSchema, { max: 119, resting: 111, threshold: 72.5 })).toEqual({
			ok: false,
			errors: {
				max: 'Max heart rate between 120 and 230',
				resting: 'Resting heart rate between 30 and 110',
				threshold: 'Threshold heart rate between 100 and 225'
			}
		});
		// Out of range and out of order: one message, the range, and none on the field below it.
		expect(validate(heartRateSchema, { resting: 105, threshold: 99 })).toEqual({
			ok: false,
			errors: { threshold: 'Threshold heart rate between 100 and 225' }
		});
		expect(validate(heartRateSchema, { max: 170, threshold: 170 })).toEqual({
			ok: false,
			errors: { threshold: 'Threshold heart rate must be below your max' }
		});
	});

	it('is optional on the running section: left out it stays out, null stays null', () => {
		const run = { unit: 'km', races: [] };
		const without = validate(runningSchema, run);
		if (!without.ok) throw new Error(JSON.stringify(without.errors));
		expect(without.data).not.toHaveProperty('heartRate');
		expect(validate(runningSchema, { ...run, heartRate: null })).toMatchObject({
			ok: true,
			data: { heartRate: null }
		});
		expect(validate(runningSchema, { ...run, heartRate: { max: 400 } })).toEqual({
			ok: false,
			errors: { 'heartRate.max': 'Max heart rate between 120 and 230' }
		});
	});
});
