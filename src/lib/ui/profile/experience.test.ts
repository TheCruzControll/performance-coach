import { describe, expect, it } from 'vitest';
import { SCHEMAS, validate } from '#lib/domain/profile/schemas.ts';
import type { ExperienceEntry } from '#lib/domain/profile/types.ts';
import {
	addableDisciplines,
	blankExperience,
	errorsByRow,
	experienceDraft,
	experiencePayload
} from './experience';

const updatedAt = new Date('2026-11-01T08:00:00Z');

const running: ExperienceEntry = {
	id: '0b6f9a52-4c1e-4f7a-9d3b-2a8c5e1f0001',
	discipline: 'running',
	customLabel: null,
	level: 'intermediate',
	years: 3,
	sessionsPerWeek: 4,
	notes: 'Mostly easy miles',
	updatedAt
};

const climbing: ExperienceEntry = {
	id: '0b6f9a52-4c1e-4f7a-9d3b-2a8c5e1f0002',
	discipline: 'custom',
	customLabel: 'Climbing',
	level: 'novice',
	years: 0.5,
	sessionsPerWeek: null,
	notes: null,
	updatedAt
};

const disciplinesOf = (entries: { discipline: string }[]) => entries.map((e) => e.discipline);

describe('experienceDraft', () => {
	it('starts empty when nothing is saved and no goal names a discipline', () => {
		expect(experienceDraft([], { disciplines: [] })).toEqual({ entries: [] });
	});

	it('lists saved entries first, then one blank entry per goal discipline that has none', () => {
		const { entries } = experienceDraft([running, climbing], {
			// The order the context lists them in (goal priority) does not matter: catalog order.
			disciplines: ['muay_thai', 'running', 'powerlifting']
		});
		expect(entries.map((e) => [e.discipline, e.level])).toEqual([
			['running', 'intermediate'],
			['custom', 'novice'],
			['powerlifting', null],
			['muay_thai', null]
		]);
		expect(entries[2]).toEqual({
			key: expect.any(String),
			discipline: 'powerlifting',
			customLabel: null,
			level: null,
			years: null,
			sessionsPerWeek: null,
			notes: null
		});
	});

	it('adds no blank entry for a custom discipline: one needs a name first', () => {
		const { entries } = experienceDraft([], { disciplines: ['custom', 'muay_thai'] });
		expect(disciplinesOf(entries)).toEqual(['muay_thai']);
	});

	it('copies what was saved, so editing never changes the loaded data', () => {
		const { entries } = experienceDraft([running], { disciplines: [] });
		entries[0]!.level = 'advanced';
		entries[0]!.years = 10;
		expect(running.level).toBe('intermediate');
		expect(running.years).toBe(3);
	});
});

describe('row keys', () => {
	it('are the saved id, or made up for a new row and unlike every row listed', () => {
		const draft = experienceDraft([running], { disciplines: ['muay_thai'] });
		draft.entries.push(blankExperience('custom', draft.entries));
		draft.entries.push(blankExperience('custom', draft.entries));
		const keys = draft.entries.map((e) => e.key);
		expect(keys[0]).toBe(running.id);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('are never one still in use, after a row in the middle went too', () => {
		const draft = experienceDraft([], { disciplines: [] });
		for (let i = 0; i < 3; i++) draft.entries.push(blankExperience('custom', draft.entries));
		draft.entries.splice(1, 1);
		draft.entries.push(blankExperience('custom', draft.entries));
		const keys = draft.entries.map((e) => e.key);
		expect(new Set(keys).size).toBe(3);
	});

	it('come back the same for a blank row taken out and added again, which is no change', () => {
		const draft = experienceDraft([], { disciplines: ['muay_thai'] });
		const before = JSON.stringify(draft);
		draft.entries.splice(0, 1);
		draft.entries.push(blankExperience('muay_thai', draft.entries));
		expect(JSON.stringify(draft)).toBe(before);
	});
});

describe('experiencePayload', () => {
	it('posts each entry as it stands, without its key, notes the editor does not show kept', () => {
		const payload = experiencePayload(experienceDraft([running], { disciplines: [] }));
		expect(payload).toEqual({
			entries: [
				{
					discipline: 'running',
					customLabel: null,
					level: 'intermediate',
					years: 3,
					sessionsPerWeek: 4,
					notes: 'Mostly easy miles'
				}
			]
		});
	});

	it('saves straight back once every entry has a level', () => {
		const payload = experiencePayload(experienceDraft([running, climbing], { disciplines: [] }));
		expect(validate(SCHEMAS.experience, payload)).toEqual({ ok: true, data: payload });
	});

	it('keeps rows in place, so a missing level is an error on that entry', () => {
		const draft = experienceDraft([running], { disciplines: ['powerlifting', 'muay_thai'] });
		draft.entries[1]!.level = 'advanced';
		expect(validate(SCHEMAS.experience, experiencePayload(draft))).toEqual({
			ok: false,
			errors: { 'entries.2.level': 'Pick your level' }
		});
	});

	it('leaves a custom discipline without a name to the schema, which asks for one', () => {
		const draft = experienceDraft([], { disciplines: [] });
		draft.entries.push({ ...blankExperience('custom', draft.entries), level: 'new' });
		expect(validate(SCHEMAS.experience, experiencePayload(draft))).toEqual({
			ok: false,
			errors: { 'entries.0.customLabel': 'Name this discipline' }
		});
	});
});

describe('errorsByRow', () => {
	it('pins each error to the row it names, so it stays there when a row above goes', () => {
		const draft = experienceDraft([running], { disciplines: ['powerlifting', 'muay_thai'] });
		const [, powerlifting, muayThai] = draft.entries;
		const pinned = errorsByRow(
			{
				'entries.1.level': 'Pick your level',
				'entries.2.years': 'Years between 0 and 60',
				entries: 'Each discipline once',
				'entries.7.level': 'Pick your level'
			},
			draft.entries
		);
		draft.entries.splice(0, 1);
		expect(pinned).toEqual({
			[powerlifting!.key]: { level: 'Pick your level' },
			[muayThai!.key]: { years: 'Years between 0 and 60' }
		});
	});
});

describe('addableDisciplines', () => {
	it('offers every catalog discipline not listed yet, in catalog order, and always a custom one', () => {
		const { entries } = experienceDraft([running, climbing], { disciplines: ['muay_thai'] });
		expect(addableDisciplines(entries)).toEqual([
			'powerlifting',
			'weightlifting',
			'strength',
			'hypertrophy',
			'distance_running',
			'athletic',
			'custom'
		]);
		expect(addableDisciplines([])).toHaveLength(9);
	});
});
