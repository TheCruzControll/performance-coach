import { describe, expect, it } from 'vitest';
import { SCHEMAS, validate } from '#lib/domain/profile/schemas.ts';
import type { Goal } from '#lib/domain/profile/types.ts';
import { goalDraft, goalSummary, newGoal, shortIsoDate, weeksUntil, type GoalDraft } from './goals';

/** A goal as the services return it. */
const stored = (fields: Partial<Goal> = {}): Goal => ({
	id: '3f6c1b52-8d0e-4a7b-9c21-5e4d7a9b0c13',
	kind: 'event',
	title: 'First Muay Thai fight',
	disciplines: ['muay_thai'],
	customDiscipline: null,
	status: 'active',
	priority: 1,
	eventType: 'Muay Thai fight',
	eventDate: '2027-03-14',
	weightClass: '−71 kg',
	targetPerformance: 'Win, stay composed for 3 rounds',
	requirements: 'Make weight the day before',
	focus: null,
	measure: null,
	targetDate: null,
	notes: null,
	createdAt: new Date('2026-11-01T08:00:00Z'),
	updatedAt: new Date('2026-11-01T08:00:00Z'),
	...fields
});

describe('newGoal', () => {
	it('is a blank event goal, which the shared schema refuses with a message per field', () => {
		const draft = newGoal();
		expect(draft.kind).toBe('event');
		expect(draft.id).toBeUndefined();
		expect(validate(SCHEMAS.goal, draft)).toEqual({
			ok: false,
			errors: {
				title: 'Give this goal a name',
				disciplines: 'Pick at least one discipline',
				eventType: 'What kind of event is it?',
				eventDate: 'Pick the event date'
			}
		});
	});

	it('starts a general goal blank too, which the schema refuses until it says what and how', () => {
		const draft = newGoal('general');
		expect(draft).toEqual({ ...newGoal(), kind: 'general' });
		expect(validate(SCHEMAS.goal, draft)).toEqual({
			ok: false,
			errors: {
				title: 'Give this goal a name',
				disciplines: 'Pick at least one discipline',
				focus: 'What do you want to improve?',
				measure: 'How will you know it’s working?'
			}
		});
	});
});

describe('goalDraft', () => {
	it('edits an event goal as stored, every empty field as ""', () => {
		const goal = stored({ weightClass: null, targetPerformance: null, requirements: null });
		expect(goalDraft(goal)).toEqual({
			id: goal.id,
			kind: 'event',
			title: 'First Muay Thai fight',
			disciplines: ['muay_thai'],
			customDiscipline: '',
			eventType: 'Muay Thai fight',
			eventDate: '2027-03-14',
			weightClass: '',
			targetPerformance: '',
			requirements: '',
			focus: '',
			measure: '',
			targetDate: '',
			notes: '',
			status: 'active'
		} satisfies GoalDraft);
	});

	it('keeps a goal’s status, so a save posts it back as stored unless it was changed', () => {
		for (const status of ['paused', 'achieved', 'dropped'] as const) {
			const draft = goalDraft(stored({ status, priority: status === 'paused' ? 1 : null }));
			expect(draft.status).toBe(status);
			const result = validate(SCHEMAS.goal, draft);
			expect(result.ok && result.data.status, status).toBe(status);
		}
		expect(newGoal().status).toBe('active');
		expect(newGoal('general').status).toBe('active');
	});

	it('round-trips: a new goal filled in saves as the goal that edits as the same draft', () => {
		const filled: GoalDraft = {
			...newGoal(),
			title: 'First Muay Thai fight',
			disciplines: ['muay_thai', 'custom'],
			customDiscipline: 'Clinch work',
			eventType: 'Muay Thai fight',
			eventDate: '2027-03-14',
			weightClass: '−71 kg'
		};
		const result = validate(SCHEMAS.goal, filled);
		if (!result.ok) throw new Error(JSON.stringify(result.errors));
		// Blank optional fields are stored as null; the other kind's fields are not stored at all.
		expect(result.data).toEqual({
			kind: 'event',
			title: 'First Muay Thai fight',
			disciplines: ['muay_thai', 'custom'],
			customDiscipline: 'Clinch work',
			notes: null,
			eventType: 'Muay Thai fight',
			eventDate: '2027-03-14',
			weightClass: '−71 kg',
			targetPerformance: null,
			requirements: null,
			status: 'active'
		});
		const goal = stored({ ...result.data, focus: null, measure: null, targetDate: null });
		expect(goalDraft(goal)).toEqual({ ...filled, id: goal.id });
	});

	it('edits a general goal as stored, and posts back the notes the sheet does not show', () => {
		const general = stored({
			kind: 'general',
			title: 'Keep my strength',
			disciplines: ['strength'],
			eventType: null,
			eventDate: null,
			weightClass: null,
			targetPerformance: null,
			requirements: null,
			focus: 'Hold squat and deadlift',
			measure: 'Top sets at RPE 8 stay within 5%',
			targetDate: '2027-06-30',
			notes: 'Through fight camp'
		});
		const result = validate(SCHEMAS.goal, goalDraft(general));
		expect(result).toEqual({
			ok: true,
			data: {
				kind: 'general',
				title: 'Keep my strength',
				disciplines: ['strength'],
				customDiscipline: null,
				notes: 'Through fight camp',
				focus: 'Hold squat and deadlift',
				measure: 'Top sets at RPE 8 stay within 5%',
				targetDate: '2027-06-30',
				status: 'active'
			}
		});
	});

	it('copies the disciplines, so ticking one never edits the loaded goal', () => {
		const goal = stored();
		goalDraft(goal).disciplines.push('running');
		expect(goal.disciplines).toEqual(['muay_thai']);
	});
});

describe('goalSummary', () => {
	it('says what an event goal is, when and in which weight class', () => {
		expect(goalSummary(stored())).toBe('Muay Thai fight · 14 Mar 2027 · −71 kg');
	});

	it('leaves out what an event goal does not have', () => {
		const marathon = stored({ eventType: 'Marathon', eventDate: '2027-12-05', weightClass: null });
		expect(goalSummary(marathon)).toBe('Marathon · 5 Dec 2027');
	});

	it('says what a general goal improves and how it is measured', () => {
		const general = stored({
			kind: 'general',
			eventType: null,
			eventDate: null,
			weightClass: null,
			focus: 'Deadlift strength',
			measure: 'e1RM trend'
		});
		expect(goalSummary(general)).toBe('Deadlift strength · e1RM trend');
	});

	it('says by when a general goal is due, when it has a target date', () => {
		const general = stored({
			kind: 'general',
			eventType: null,
			eventDate: null,
			weightClass: null,
			focus: 'Deadlift strength',
			measure: 'e1RM trend',
			targetDate: '2027-06-30'
		});
		expect(goalSummary(general)).toBe('Deadlift strength · e1RM trend · by 30 Jun 2027');
	});
});

describe('shortIsoDate', () => {
	it('writes the day, the month’s short name and the year, without a leading zero', () => {
		expect(shortIsoDate('2027-03-14')).toBe('14 Mar 2027');
		expect(shortIsoDate('2027-01-05')).toBe('5 Jan 2027');
		expect(shortIsoDate('2026-12-31')).toBe('31 Dec 2026');
	});

	it('is blank for no date', () => {
		expect(shortIsoDate(null)).toBe('');
		expect(shortIsoDate('')).toBe('');
	});
});

describe('weeksUntil', () => {
	/** A device's local date: midday, so no time zone moves it to another day. */
	const on = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12, 0);

	it('counts whole weeks to the date, rounding down', () => {
		expect(weeksUntil('2026-11-21', on(2026, 11, 7))).toBe(2);
		expect(weeksUntil('2026-11-20', on(2026, 11, 7))).toBe(1);
		expect(weeksUntil('2026-11-14', on(2026, 11, 7))).toBe(1);
		expect(weeksUntil('2026-11-13', on(2026, 11, 7))).toBe(0);
	});

	it('is 0 on the day itself, and null once the date has passed or there is none', () => {
		expect(weeksUntil('2026-11-07', on(2026, 11, 7))).toBe(0);
		expect(weeksUntil('2026-11-06', on(2026, 11, 7))).toBeNull();
		expect(weeksUntil(null, on(2026, 11, 7))).toBeNull();
	});

	it('reads the device’s calendar day, whatever the time on its clock', () => {
		expect(weeksUntil('2026-11-14', new Date(2026, 10, 7, 0, 1))).toBe(1);
		expect(weeksUntil('2026-11-14', new Date(2026, 10, 7, 23, 59))).toBe(1);
		expect(weeksUntil('2026-11-07', new Date(2026, 10, 7, 23, 59))).toBe(0);
	});

	it('counts across month and year ends, and over a daylight-saving change', () => {
		// 31 Jan → 28 Feb is 28 days; 28 Dec → 4 Jan is 7 days across the new year.
		expect(weeksUntil('2027-02-28', on(2027, 1, 31))).toBe(4);
		expect(weeksUntil('2027-01-04', on(2026, 12, 28))).toBe(1);
		expect(weeksUntil('2027-01-03', on(2026, 12, 28))).toBe(0);
		// 14 March 2027 is three weeks after 21 February, with a clock change in between in the US.
		expect(weeksUntil('2027-03-14', on(2027, 2, 21))).toBe(3);
		expect(weeksUntil('2027-03-14', on(2026, 3, 14))).toBe(52);
	});
});
