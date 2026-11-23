import { describe, expect, it } from 'vitest';
import type {
	BodyWeightEntry,
	ExperienceEntry,
	Goal,
	Injury,
	StrengthBaseline,
	TrainingProfile
} from '#lib/domain/profile/types.ts';
import { NBSP } from '#lib/domain/units.ts';
import { passkeysAnswer, sectionAnswers } from './answers';
import { SECTION_GROUPS, SECTIONS, sectionsIn } from './sections';

const at = new Date('2026-11-01T08:00:00Z');

/** A profile with kg and km and nothing else. */
function blank(): TrainingProfile {
	return {
		profile: {
			name: 'Niko',
			weightUnit: 'kg',
			distanceUnit: 'km',
			timeZone: 'UTC',
			birthYear: null,
			nutritionPhase: null,
			targetWeight: null,
			targetDate: null,
			baselinesUnknown: false,
			onboarding: { current: null, completed: [], skipped: [], completedAt: null },
			updatedAt: at
		},
		bodyWeight: [],
		goals: [],
		experience: [],
		baselines: [],
		running: null,
		muayThai: null,
		equipment: null,
		injuries: [],
		exercises: [],
		schedule: {
			daysPerWeek: null,
			availableDays: [],
			preferredTimes: [],
			sessionMinutes: null,
			constraints: null,
			commitments: [],
			updatedAt: null
		}
	};
}

const goal = (id: string, priority: number | null) =>
	({ id, priority, status: priority === null ? 'achieved' : 'active' }) as Goal;

const weighIn = (value: number, measuredOn: string): BodyWeightEntry => ({
	id: value,
	value,
	unit: 'kg',
	measuredOn,
	source: 'profile'
});

const injury = (bodyArea: Injury['bodyArea'], side: Injury['side'], active = true) =>
	({ id: `${bodyArea}-${side}`, bodyArea, side, active }) as Injury;

const lift = (
	l: StrengthBaseline['lift'],
	value: number,
	more: Partial<StrengthBaseline> = {}
): StrengthBaseline =>
	({
		id: l,
		lift: l,
		customLabel: null,
		kind: 'measured',
		value,
		unit: 'kg',
		...more
	}) as StrengthBaseline;

const level = (l: ExperienceEntry['level']) => ({ level: l }) as ExperienceEntry;

describe('sectionAnswers', () => {
	it('answers goals, units and injuries on a blank profile, and nothing else', () => {
		expect(sectionAnswers(blank())).toEqual({ goals: 'None', basics: 'kg, km', injuries: 'None' });
	});

	it('gives each section its answer on a full profile', () => {
		const t = blank();
		t.profile.distanceUnit = 'mi';
		t.goals = [goal('a', 1), goal('b', 2), goal('c', 3), goal('done', null)];
		t.bodyWeight = [weighIn(79.1, '2026-10-30'), weighIn(78.4, '2026-11-01')];
		t.injuries = [injury('knee', 'left'), injury('hip', null, false)];
		t.schedule.daysPerWeek = 6;
		t.equipment = {
			gymType: 'commercial',
			equipment: [],
			homeEquipment: [],
			notes: null,
			updatedAt: at
		};
		t.baselines = [lift('deadlift', 180), lift('back_squat', 102.5)];
		t.experience = [level('intermediate'), level('intermediate')];

		expect(sectionAnswers(t)).toEqual({
			goals: '3',
			basics: 'kg, mi',
			body: `78.4${NBSP}kg`,
			injuries: 'Left knee',
			schedule: '6 days',
			equipment: 'Commercial gym',
			strength: `Back squat 102.5${NBSP}kg`,
			experience: 'Intermediate'
		});
	});

	it('falls back to a count, the available days, the nutrition phase or the lift’s own name', () => {
		const t = blank();
		t.injuries = [injury('knee', 'left'), injury('shoulder', 'right')];
		t.experience = [level('novice'), level('advanced'), level('advanced')];
		t.schedule.availableDays = ['mon'];
		t.profile.nutritionPhase = 'cut';
		t.baselines = [
			lift('custom', 151.2, { customLabel: 'Trap bar', kind: 'estimated', source: 'estimate' })
		];
		const answers = sectionAnswers(t);
		expect(answers.injuries).toBe('2 injuries');
		expect(answers.experience).toBe('3 disciplines');
		expect(answers.schedule).toBe('1 day');
		expect(answers.body).toBe('Cut');
		expect(answers.strength).toBe(`Trap bar ≈ 151${NBSP}kg`);
	});

	it('names an injury on both sides by its area alone', () => {
		const t = blank();
		t.injuries = [injury('knee', 'both')];
		expect(sectionAnswers(t).injuries).toBe('Knee');
	});

	it('names an "other" injury by its area alone, with no side', () => {
		const t = blank();
		t.injuries = [injury('other', 'left')];
		expect(sectionAnswers(t).injuries).toBe('Other');
	});

	it('shows the latest weigh-in in the profile’s unit, as Body does', () => {
		const t = blank();
		t.profile.weightUnit = 'lb';
		t.bodyWeight = [weighIn(78.4, '2026-11-01')];
		expect(sectionAnswers(t).body).toBe(`172.8${NBSP}lb`);
	});
});

describe('passkeysAnswer', () => {
	it('counts the passkeys', () => {
		expect(passkeysAnswer(1)).toBe('1 passkey');
		expect(passkeysAnswer(2)).toBe('2 passkeys');
	});
});

describe('the sections', () => {
	it('are grouped You, then Training, in the order of SECTIONS', () => {
		expect(SECTION_GROUPS.flatMap((g) => sectionsIn(g.id)).map((s) => s.key)).toEqual(
			SECTIONS.map((s) => s.key)
		);
		expect(sectionsIn('you').map((s) => s.title)).toEqual([
			'Goals',
			'Name and units',
			'Body and nutrition',
			'Injuries'
		]);
		expect(sectionsIn('training').map((s) => s.title)).toEqual([
			'Schedule',
			'Equipment',
			'Strength',
			'Experience',
			'Running and Muay Thai',
			'Exercises you like and avoid'
		]);
	});
});
