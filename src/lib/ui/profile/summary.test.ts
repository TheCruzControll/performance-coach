import { describe, expect, it } from 'vitest';
import type {
	EquipmentProfile,
	Goal,
	MuayThaiProfile,
	RaceResult,
	RunningProfile
} from '#lib/domain/profile/types.ts';
import {
	baselineValue,
	bodyLines,
	equipmentLines,
	experienceLine,
	injuryLine,
	muayThaiLine,
	raceLine,
	rankedGoals,
	runningLine
} from './summary';

const at = new Date('2026-11-01T08:00:00Z');

const running: RunningProfile = {
	unit: 'km',
	weeklyDistance: null,
	runsPerWeek: null,
	longestRun: null,
	easyPaceSeconds: null,
	races: [],
	notes: null,
	updatedAt: at
};

const muayThai: MuayThaiProfile = {
	sessionsPerWeek: null,
	sparringPerWeek: null,
	fights: null,
	notes: null,
	updatedAt: at
};

const equipment: EquipmentProfile = {
	gymType: null,
	equipment: [],
	homeEquipment: [],
	notes: null,
	updatedAt: at
};

const goal = (id: string, priority: number | null) => ({ id, priority }) as Goal;

describe('rankedGoals', () => {
	it('keeps the open goals, top priority first', () => {
		const goals = [goal('b', 2), goal('done', null), goal('a', 1)];
		expect(rankedGoals(goals).map((g) => g.id)).toEqual(['a', 'b']);
	});
});

describe('experienceLine', () => {
	it('says the level, then the years and sessions a week when known', () => {
		expect(experienceLine({ level: 'novice', years: 3, sessionsPerWeek: 2 })).toBe(
			'Novice · 3 years · 2 a week'
		);
		expect(experienceLine({ level: 'advanced', years: 1, sessionsPerWeek: null })).toBe(
			'Advanced · 1 year'
		);
		expect(experienceLine({ level: 'new', years: null, sessionsPerWeek: null })).toBe('New');
	});

	it('keeps a zero: no years yet is something the owner said', () => {
		expect(experienceLine({ level: 'new', years: 0, sessionsPerWeek: 0 })).toBe(
			'New · 0 years · 0 a week'
		);
	});
});

describe('baselineValue', () => {
	it('marks an estimate as approximate, never a lifted max', () => {
		expect(baselineValue({ kind: 'measured', value: 140, unit: 'kg' })).toBe('140\u00a0kg');
		expect(baselineValue({ kind: 'measured', value: 142.25, unit: 'kg' })).toBe('142.25\u00a0kg');
		// An estimate to the nearest 1 lb or 0.5 kg, never '123.33 lb'.
		expect(baselineValue({ kind: 'estimated', value: 123.333, unit: 'lb' })).toBe('≈ 123\u00a0lb');
		expect(baselineValue({ kind: 'estimated', value: 157.21, unit: 'kg' })).toBe('≈ 157\u00a0kg');
		expect(baselineValue({ kind: 'estimated', value: 157.3, unit: 'kg' })).toBe('≈ 157.5\u00a0kg');
	});
});

describe('runningLine', () => {
	it('says what is known about the running, in the profile’s unit', () => {
		expect(
			runningLine({
				...running,
				unit: 'mi',
				weeklyDistance: 25,
				runsPerWeek: 4,
				longestRun: 13.1,
				easyPaceSeconds: 545
			})
		).toBe('25 mi a week · 4 runs · longest 13.1 mi · easy 9:05/mi');
		expect(runningLine({ ...running, runsPerWeek: 1 })).toBe('1 run');
	});

	it('is empty when nothing is known', () => {
		expect(runningLine(running)).toBe('');
	});
});

describe('raceLine', () => {
	const race: RaceResult = {
		id: 'r',
		distance: 'half_marathon',
		customDistance: null,
		distanceMetres: 21097.5,
		timeSeconds: 6330,
		racedOn: null,
		eventName: null
	};

	it('names the distance and the time', () => {
		expect(raceLine(race, 'km')).toBe('Half marathon in 1:45:30');
	});

	it('gives an “other” race its own distance in the running unit', () => {
		expect(
			raceLine({ ...race, distance: 'other', customDistance: 15, timeSeconds: 4200 }, 'mi')
		).toBe('15 mi in 1:10:00');
	});
});

describe('muayThaiLine', () => {
	it('says sessions, sparring and fights when known', () => {
		expect(muayThaiLine({ ...muayThai, sessionsPerWeek: 3, sparringPerWeek: 1, fights: 2 })).toBe(
			'3 sessions a week · 1 sparring · 2 fights'
		);
		expect(muayThaiLine({ ...muayThai, sessionsPerWeek: 1, fights: 1 })).toBe(
			'1 session a week · 1 fight'
		);
		expect(muayThaiLine({ ...muayThai, fights: 0 })).toBe('0 fights');
		expect(muayThaiLine(muayThai)).toBe('');
	});
});

describe('equipmentLines', () => {
	it('names the place, the kit there and the kit at home', () => {
		expect(
			equipmentLines({
				...equipment,
				gymType: 'home',
				equipment: ['barbell', 'squat_rack'],
				homeEquipment: ['bands']
			})
		).toEqual({ place: 'Home or garage gym', kit: 'Barbell & plates, Squat rack', home: 'Bands' });
		expect(equipmentLines({ ...equipment, equipment: ['dumbbells'] })).toEqual({
			place: 'Gym',
			kit: 'Dumbbells',
			home: ''
		});
	});

	it('is null when nothing was said', () => {
		expect(equipmentLines(null)).toBeNull();
		expect(equipmentLines(equipment)).toBeNull();
	});
});

describe('injuryLine', () => {
	it('says how bad it is and what to avoid, in the owner’s words', () => {
		expect(injuryLine({ severity: 'moderate', avoid: ['Box jumps', 'Jumping lunges'] })).toBe(
			'Moderate · avoid Box jumps, Jumping lunges'
		);
		expect(injuryLine({ severity: 'mild', avoid: [] })).toBe('Mild');
	});
});

describe('bodyLines', () => {
	const profile = {
		nutritionPhase: null,
		targetWeight: null,
		targetDate: null,
		weightUnit: 'kg'
	} as const;

	it('gives the latest weigh-in in its own unit, and the plan', () => {
		expect(
			bodyLines(
				{ ...profile, nutritionPhase: 'cut', targetWeight: 78, targetDate: '2027-03-14' },
				{ value: 182.4, unit: 'lb' }
			)
		).toEqual({ weight: '182.4 lb', plan: 'Cut · target 78 kg by 14 Mar 2027' });
		expect(bodyLines({ ...profile, nutritionPhase: 'maintenance' }, undefined)).toEqual({
			weight: null,
			plan: 'Maintenance'
		});
	});

	it('leaves out a target date with no target weight', () => {
		expect(bodyLines({ ...profile, targetDate: '2027-03-14' }, { value: 80, unit: 'kg' })).toEqual({
			weight: '80 kg',
			plan: ''
		});
	});

	it('is null when nothing was said', () => {
		expect(bodyLines(profile, undefined)).toBeNull();
	});
});
