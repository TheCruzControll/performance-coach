import { describe, expect, it } from 'vitest';
import { SCHEMAS, validate } from '#lib/domain/profile/schemas.ts';
import type { Goal } from '#lib/domain/profile/types.ts';
import { goalDraft, goalSummary, newGoal, shortIsoDate, type GoalDraft } from './goals';

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
			notes: ''
		} satisfies GoalDraft);
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
			requirements: null
		});
		const goal = stored({ ...result.data, focus: null, measure: null, targetDate: null });
		expect(goalDraft(goal)).toEqual({ ...filled, id: goal.id });
	});

	it('posts back what the sheet does not show: a general goal’s fields and the notes', () => {
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
				targetDate: '2027-06-30'
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
