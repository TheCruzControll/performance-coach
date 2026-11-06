/**
 * The sections Profile edits at /profile/[section] (src/lib/server/forms/sections.ts) on real
 * Postgres: each loads what its editor starts from and saves through its service, every editor
 * is told the athlete's disciplines and units, and a key that is not a section is a 404, so the
 * route needs no param matcher.
 */
import { isHttpError } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import {
	profileSection,
	SECTION_KEYS,
	sectionContext
} from '../../../src/lib/server/forms/sections';
import { createGoal, saveBasics, saveExperience } from '../../../src/lib/server/services/profile';
import { EDITORS } from '../../../src/lib/ui/profile/editors';
import { SECTIONS } from '../../../src/lib/ui/profile/sections';
import { withRollback } from '../helpers';
import { eventGoal, makeOwner } from './fixtures';

const equipment = {
	gymType: 'home',
	equipment: ['barbell', 'squat_rack', 'bench'],
	homeEquipment: [],
	notes: 'Garage, no heating'
};

describe('a Profile section', () => {
	it('loads nothing for a new owner, then what was saved through it', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const section = profileSection('equipment');
			expect(await section.load(owner, { db })).toBeNull();
			await section.save(owner, equipment, { db, source: 'profile' });
			expect(await section.load(owner, { db })).toMatchObject(equipment);
		});
	});

	it('Schedule starts with nothing set, then loads what it saved, commitments included', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const schedule = profileSection('schedule');
			expect(await schedule.load(owner, { db })).toMatchObject({
				daysPerWeek: null,
				sessionMinutes: null,
				commitments: []
			});
			const week = {
				daysPerWeek: 4,
				availableDays: ['tue', 'thu', 'sat', 'sun'],
				preferredTimes: ['evening'],
				sessionMinutes: 75,
				constraints: null,
				commitments: [
					{
						id: null,
						discipline: 'muay_thai',
						label: 'Muay Thai class',
						days: ['tue', 'thu'],
						timeOfDay: 'evening',
						durationMinutes: 90,
						intensity: 'hard',
						notes: null
					}
				]
			};
			await schedule.save(owner, week, { db, source: 'profile' });
			const { commitments, ...rest } = week;
			const loaded = await schedule.load(owner, { db });
			expect(loaded).toMatchObject(rest);
			expect(loaded).toMatchObject({
				commitments: [{ ...commitments[0], id: expect.any(String) }]
			});
		});
	});

	it('is a 404 for any key that is not a section, inherited object keys included', () => {
		for (const key of [
			'unknown',
			'sample',
			'',
			'Equipment',
			'constructor',
			'__proto__',
			'toString'
		]) {
			let thrown: unknown;
			try {
				profileSection(key);
			} catch (err) {
				thrown = err;
			}
			expect(isHttpError(thrown, 404), key).toBe(true);
		}
	});

	it('exists on Profile, on the server and as an editor, for the same keys', () => {
		const listed = SECTIONS.map((s) => s.key).sort();
		expect(listed).toEqual([...SECTION_KEYS].sort());
		expect(listed).toEqual(Object.keys(EDITORS).sort());
	});
});

describe('the context every editor gets', () => {
	it('defaults to no disciplines yet, in kg and km', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			expect(await sectionContext(owner, { db })).toEqual({
				disciplines: [],
				units: { weight: 'kg', distance: 'km' }
			});
		});
	});

	it('lists the disciplines of open goals and experience, in the owner’s units', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			await saveBasics(owner, { name: 'Niko', weightUnit: 'lb', distanceUnit: 'mi' }, { db });
			await createGoal(owner, eventGoal({ disciplines: ['muay_thai'] }), { db });
			await saveExperience(
				owner,
				{ entries: [{ discipline: 'running', level: 'intermediate', years: 3 }] },
				{ db }
			);
			const context = await sectionContext(owner, { db });
			expect(context.units).toEqual({ weight: 'lb', distance: 'mi' });
			expect([...context.disciplines].sort()).toEqual(['muay_thai', 'running']);
		});
	});
});
