/**
 * The sections Profile edits at /profile/[section] (src/lib/server/forms/sections.ts) on real
 * Postgres: each loads what its editor starts from and saves through its service (goals one at a
 * time instead), every editor is told the athlete's disciplines and units, and a key that is not
 * a section is a 404, so the route needs no param matcher.
 */
import { isHttpError } from '@sveltejs/kit';
import { describe, expect, it } from 'vitest';
import type { Goal } from '../../../src/lib/domain/profile/types';
import {
	profileSection,
	SECTION_KEYS,
	sectionContext
} from '../../../src/lib/server/forms/sections';
import { createGoal, saveBasics, saveExperience } from '../../../src/lib/server/services/profile';
import { bodyDraft, bodyPayload, type BodySaved } from '../../../src/lib/ui/profile/body';
import { EDITORS } from '../../../src/lib/ui/profile/editors';
import { SECTIONS } from '../../../src/lib/ui/profile/sections';
import { withRollback } from '../helpers';
import { clock, eventGoal, makeOwner } from './fixtures';

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
			await section.save!(owner, equipment, { db, source: 'profile' });
			expect(await section.load(owner, { db })).toMatchObject(equipment);
		});
	});

	it('loads the goals top priority first; they save one at a time, never as a whole', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const goals = profileSection('goals');
			expect(goals.save).toBeUndefined();
			expect(await goals.load(owner, { db })).toEqual([]);
			await createGoal(owner, eventGoal(), { db });
			await createGoal(owner, eventGoal({ title: 'Valencia marathon' }), { db });
			const loaded = (await goals.load(owner, { db })) as Goal[];
			expect(loaded.map((g) => [g.title, g.priority])).toEqual([
				['First Muay Thai fight', 1],
				['Valencia marathon', 2]
			]);
			for (const key of SECTION_KEYS.filter((k) => k !== 'goals')) {
				expect(profileSection(key).save, key).toBeTypeOf('function');
			}
		});
	});

	it('Name & units starts from the owner’s name in kg and km, then loads what it saved', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db, 'Niko Cruz');
			const basics = profileSection('basics');
			expect(await basics.load(owner, { db })).toMatchObject({
				name: 'Niko Cruz',
				weightUnit: 'kg',
				distanceUnit: 'km'
			});
			await saveBasics(
				owner,
				{ name: 'Niko Cruz', weightUnit: 'kg', distanceUnit: 'km', timeZone: 'Europe/London' },
				{ db }
			);
			const edited = { name: 'Niko', weightUnit: 'lb', distanceUnit: 'mi' };
			await basics.save!(owner, edited, { db, source: 'profile' });
			// The editor sends no time zone: the saved one stays.
			expect(await basics.load(owner, { db })).toMatchObject({
				...edited,
				timeZone: 'Europe/London'
			});
		});
	});

	it('Body edits the profile and today’s weight, and a converted weight left as it was records nothing', async () => {
		await withRollback(async (db) => {
			const owner = await makeOwner(db);
			const time = clock('2026-11-05T09:00:00Z');
			const deps = { db, now: time.now, source: 'profile' as const };
			const section = profileSection('body');
			const blank = bodyDraft((await section.load(owner, deps)) as BodySaved);
			expect(blank).toMatchObject({ weightUnit: 'kg', bodyWeight: null, nutritionPhase: 'none' });

			await section.save!(
				owner,
				bodyPayload({ ...blank, bodyWeight: 82.4, targetWeight: 78 }),
				deps
			);
			await saveBasics(owner, { name: 'Niko', weightUnit: 'lb', distanceUnit: 'km' }, { db });
			time.advanceDays(1);
			const inPounds = bodyDraft((await section.load(owner, deps)) as BodySaved);
			// The 78 kg target too: saved as it shows, it stays 78 kg, not 78 lb.
			expect(inPounds).toMatchObject({ weightUnit: 'lb', bodyWeight: 181.7, targetWeight: 172 });
			await section.save!(owner, bodyPayload({ ...inPounds, nutritionPhase: 'cut' }), deps);
			expect(await section.load(owner, deps)).toMatchObject({
				profile: { nutritionPhase: 'cut', targetWeight: 172, targetWeightUnit: 'lb' },
				bodyWeight: [{ value: 82.4, unit: 'kg', measuredOn: '2026-11-05', source: 'profile' }]
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
