import { describe, expect, it } from 'vitest';
import { addDays } from '../../../domain/calendar';
import { validate } from '../../../domain/validation';
import { DEFAULT_PROGRAM_START, previewRequestSchema, START_OPTIONS, startDates } from './start';

const MONDAY = '2026-11-09';

describe('when a new program starts', () => {
	it('starts next Monday by default, or today when today is a Monday', () => {
		expect(DEFAULT_PROGRAM_START).toBe('next_monday');
		expect(startDates(MONDAY, 'next_monday')).toEqual({
			startsOn: MONDAY,
			firstPlannedDay: MONDAY
		});
		for (let day = 1; day <= 6; day++) {
			const next = addDays(MONDAY, 7);
			expect(startDates(addDays(MONDAY, day), 'next_monday')).toEqual({
				startsOn: next,
				firstPlannedDay: next
			});
		}
	});

	it("plans 'This week' from today, in the week today is in", () => {
		expect(START_OPTIONS).toEqual(['next_monday', 'this_week']);
		for (let day = 0; day <= 6; day++) {
			const today = addDays(MONDAY, day);
			expect(startDates(today, 'this_week')).toEqual({ startsOn: MONDAY, firstPlannedDay: today });
		}
	});

	it('starts on a picked day in the week it is in, planned from that day', () => {
		expect(startDates('2026-11-10', '2026-11-12')).toEqual({
			startsOn: '2026-11-09',
			firstPlannedDay: '2026-11-12'
		});
	});

	it('reads a named start or a day, and refuses anything else in words for the field', () => {
		const today = '2026-11-10';
		expect(validate(previewRequestSchema, { today, start: '2026-11-12' })).toEqual({
			ok: true,
			data: { today, start: '2026-11-12' }
		});
		expect(validate(previewRequestSchema, { today, start: 'this_week' })).toEqual({
			ok: true,
			data: { today, start: 'this_week' }
		});
		expect(validate(previewRequestSchema, { today, start: 'someday' })).toEqual({
			ok: false,
			errors: { start: 'Pick when to start' }
		});
	});
});
