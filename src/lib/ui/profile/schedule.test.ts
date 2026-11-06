import { describe, expect, it } from 'vitest';
import { SCHEMAS, validate } from '#lib/domain/profile/schemas.ts';
import type { Commitment, Schedule } from '#lib/domain/profile/types.ts';
import {
	blankCommitment,
	commitmentDisciplines,
	commitmentErrors,
	commitmentSummary,
	daysText,
	scheduleDraft,
	schedulePayload,
	scheduleSummary,
	suggestedDays,
	type ScheduleDraft
} from './schedule';

const muayThai: Commitment = {
	id: '7d0f3c1e-8a4b-4c2d-9e6f-1a2b3c4d5e6f',
	discipline: 'muay_thai',
	label: 'Muay Thai class',
	days: ['tue', 'thu'],
	timeOfDay: 'evening',
	durationMinutes: 90,
	intensity: 'hard',
	notes: 'Sparring on Thursdays'
};

const nothingSaved: Schedule = {
	daysPerWeek: null,
	availableDays: [],
	preferredTimes: [],
	sessionMinutes: null,
	constraints: null,
	commitments: [],
	updatedAt: null
};

const saved: Schedule = {
	daysPerWeek: 4,
	availableDays: ['tue', 'thu', 'sat', 'sun'],
	preferredTimes: ['evening'],
	sessionMinutes: 75,
	constraints: 'Night shifts every other week',
	commitments: [muayThai],
	updatedAt: new Date('2026-11-01T08:00:00Z')
};

describe('scheduleDraft', () => {
	it('has no days or session length of its own when nothing is saved: those are suggested', () => {
		expect(scheduleDraft(nothingSaved)).toEqual({
			daysPerWeek: null,
			availableDays: [],
			preferredTimes: [],
			sessionMinutes: null,
			constraints: null,
			commitments: []
		});
	});

	it('edits what was saved, each commitment keyed by its id and keeping its notes', () => {
		expect(scheduleDraft(saved)).toEqual({
			daysPerWeek: 4,
			availableDays: ['tue', 'thu', 'sat', 'sun'],
			preferredTimes: ['evening'],
			sessionMinutes: 75,
			constraints: 'Night shifts every other week',
			commitments: [{ key: muayThai.id, ...muayThai }]
		});
	});

	it('copies the lists, so ticking a day never edits the loaded data', () => {
		const draft = scheduleDraft(saved);
		draft.availableDays.push('mon');
		draft.preferredTimes.length = 0;
		draft.commitments[0]!.days.push('sat');
		expect(saved.availableDays).toEqual(['tue', 'thu', 'sat', 'sun']);
		expect(saved.preferredTimes).toEqual(['evening']);
		expect(muayThai.days).toEqual(['tue', 'thu']);
	});
});

describe('the suggestion', () => {
	it('is 4 days of 60 minutes, or every available day when fewer than 4 are picked', () => {
		expect(suggestedDays([])).toBe(4);
		expect(suggestedDays(['mon', 'wed', 'fri'])).toBe(3);
		expect(suggestedDays(['mon', 'tue', 'wed', 'thu', 'fri', 'sat'])).toBe(4);
		expect(schedulePayload(scheduleDraft(nothingSaved))).toMatchObject({
			daysPerWeek: 4,
			sessionMinutes: 60
		});
		const threeDays: ScheduleDraft = {
			...scheduleDraft(nothingSaved),
			availableDays: ['mon', 'wed', 'fri']
		};
		expect(schedulePayload(threeDays).daysPerWeek).toBe(3);
	});

	it('gives way to the owner’s own numbers', () => {
		const draft = { ...scheduleDraft(nothingSaved), daysPerWeek: 6, sessionMinutes: 45 };
		expect(schedulePayload(draft)).toMatchObject({ daysPerWeek: 6, sessionMinutes: 45 });
	});
});

describe('schedulePayload', () => {
	it('posts what the schema takes: no card keys, ids kept, new ones without', () => {
		const draft = scheduleDraft(saved);
		draft.commitments.push({
			...blankCommitment(['running'], draft.commitments),
			label: 'Club run',
			days: ['wed']
		});
		const payload = schedulePayload(draft);
		expect(payload.commitments).toEqual([
			{
				id: muayThai.id,
				discipline: 'muay_thai',
				label: 'Muay Thai class',
				days: ['tue', 'thu'],
				timeOfDay: 'evening',
				durationMinutes: 90,
				intensity: 'hard',
				notes: 'Sparring on Thursdays'
			},
			{
				id: null,
				discipline: 'running',
				label: 'Club run',
				days: ['wed'],
				timeOfDay: null,
				durationMinutes: null,
				intensity: null,
				notes: null
			}
		]);
		const result = validate(SCHEMAS.schedule, payload);
		expect(result.ok).toBe(true);
	});

	it('saves straight back: nothing saved, or what was, passes the shared schema as it stands', () => {
		expect(validate(SCHEMAS.schedule, schedulePayload(scheduleDraft(nothingSaved))).ok).toBe(true);
		expect(validate(SCHEMAS.schedule, schedulePayload(scheduleDraft(saved)))).toEqual({
			ok: true,
			data: {
				daysPerWeek: 4,
				availableDays: ['tue', 'thu', 'sat', 'sun'],
				preferredTimes: ['evening'],
				sessionMinutes: 75,
				constraints: 'Night shifts every other week',
				commitments: [muayThai]
			}
		});
	});

	it('keeps commitments in their places, so the schema’s errors name the right card', () => {
		const draft = scheduleDraft(saved);
		draft.commitments.push(blankCommitment([], draft.commitments));
		const result = validate(SCHEMAS.schedule, schedulePayload(draft));
		expect(result.ok).toBe(false);
		expect(!result.ok && result.errors).toEqual({
			'commitments.1.label': 'Name the commitment',
			'commitments.1.days': 'Pick at least one day'
		});
	});
});

describe('blankCommitment', () => {
	it('is a Muay Thai class when Muay Thai is in play, else the first discipline in play', () => {
		expect(blankCommitment(['strength', 'muay_thai'], []).discipline).toBe('muay_thai');
		expect(blankCommitment(['running', 'strength'], []).discipline).toBe('running');
		expect(blankCommitment([], []).discipline).toBe('athletic');
	});

	it('starts blank, with no number made up for it', () => {
		expect(blankCommitment(['muay_thai'], [])).toEqual({
			key: 'new:1',
			id: null,
			discipline: 'muay_thai',
			label: '',
			days: [],
			timeOfDay: null,
			durationMinutes: null,
			intensity: null,
			notes: null
		});
	});

	it('takes a key no card has, so each new card keeps its own', () => {
		const first = blankCommitment([], []);
		const second = blankCommitment([], [first]);
		const third = blankCommitment([], [second]);
		expect([first.key, second.key, third.key]).toEqual(['new:1', 'new:2', 'new:1']);
		expect(blankCommitment([], [{ ...first, key: muayThai.id }]).key).toBe('new:1');
	});
});

describe('commitmentDisciplines', () => {
	it('offers the usual commitments and those in play, in catalog order', () => {
		expect(commitmentDisciplines([])).toEqual(['running', 'muay_thai', 'athletic', 'custom']);
		expect(commitmentDisciplines(['hypertrophy', 'muay_thai'])).toEqual([
			'hypertrophy',
			'running',
			'muay_thai',
			'athletic',
			'custom'
		]);
	});

	it('keeps the discipline a commitment already has, whatever is in play', () => {
		expect(commitmentDisciplines([], 'powerlifting')).toEqual([
			'powerlifting',
			'running',
			'muay_thai',
			'athletic',
			'custom'
		]);
	});
});

describe('commitmentErrors', () => {
	it('pins each card’s errors to its key; schedule-wide errors are left out', () => {
		const draft = scheduleDraft(saved);
		const club = { ...blankCommitment([], draft.commitments), label: 'Club run' };
		const cards = [...draft.commitments, club];
		expect(
			commitmentErrors(
				{
					daysPerWeek: 'Between 1 and 7 days',
					commitments: 'Too many commitments',
					'commitments.0.durationMinutes': 'Between 10 and 300 minutes',
					'commitments.1.days': 'Pick at least one day',
					'commitments.1.label': 'Name the commitment',
					'commitments.7.days': 'Pick at least one day'
				},
				cards
			)
		).toEqual({
			[muayThai.id]: { durationMinutes: 'Between 10 and 300 minutes' },
			[club.key]: { days: 'Pick at least one day', label: 'Name the commitment' }
		});
	});
});

describe('summaries', () => {
	it('lists days Monday first, whatever order they come in', () => {
		expect(daysText(['thu', 'tue'])).toBe('Tue, Thu');
		expect(daysText(['sun', 'mon', 'sat'])).toBe('Mon, Sat, Sun');
		expect(daysText(['sat', 'sun', 'fri', 'thu', 'wed', 'tue', 'mon'])).toBe('Every day');
		expect(daysText([])).toBe('');
	});

	it('sums a commitment up from what is known about it', () => {
		expect(commitmentSummary(muayThai)).toBe('Tue, Thu · evening · 90 min · hard');
		expect(
			commitmentSummary({
				days: ['sat'],
				timeOfDay: 'varies',
				durationMinutes: null,
				intensity: null
			})
		).toBe('Sat · time varies');
		expect(
			commitmentSummary({
				days: ['wed', 'mon'],
				timeOfDay: null,
				durationMinutes: 45,
				intensity: 'light'
			})
		).toBe('Mon, Wed · 45 min · light');
	});

	it('sums the schedule up, or says it is not set yet', () => {
		expect(scheduleSummary(nothingSaved)).toBe('Not set yet');
		expect(scheduleSummary(saved)).toBe('4 days a week · 75 min sessions · evening');
		expect(
			scheduleSummary({
				daysPerWeek: 1,
				sessionMinutes: null,
				preferredTimes: ['evening', 'varies', 'early_morning']
			})
		).toBe('1 day a week · early morning or evening');
		expect(
			scheduleSummary({ daysPerWeek: 3, sessionMinutes: 45, preferredTimes: ['varies'] })
		).toBe('3 days a week · 45 min sessions');
	});
});
