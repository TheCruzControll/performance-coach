/**
 * input.ts and the fingerprint over it: a TrainingProfile as M2's services return it becomes the
 * generator's canonical input, with every 'not told yet' default applied and listed, and the
 * fingerprint moves with what can change the program and nothing else.
 */
import { describe, expect, it } from 'vitest';
import { CATALOGUE } from '../exercises/index';
import { EQUIPMENT, WEEKDAYS } from '../profile/catalog';
import type {
	Commitment,
	ExperienceEntry,
	Goal,
	Injury,
	StrengthBaseline,
	TrainingProfile
} from '../profile/types';
import type { CustomExercise } from '../training/types';
import { buildProgrammingInput, toExerciseKey, toExerciseRef, weeksToEvent } from './input';
import type { InputSources, OwnedExercise } from './input';
import { catalogueDigest, fingerprint, GENERATOR_ID } from './random';
import { DEFAULTS, GYM_PRESETS } from './rules/defaults';

const AT = new Date('2026-11-01T08:00:00Z');
const LATER = new Date('2026-11-04T19:30:00Z');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function goal(over: Partial<Goal> & Pick<Goal, 'title' | 'disciplines'>): Goal {
	return {
		id: id(100 + (over.priority ?? 9)),
		kind: 'general',
		customDiscipline: null,
		status: 'active',
		priority: 1,
		eventType: null,
		eventDate: null,
		weightClass: null,
		targetPerformance: null,
		requirements: null,
		focus: 'Be stronger',
		measure: 'Heavier sets',
		targetDate: null,
		notes: null,
		createdAt: AT,
		updatedAt: AT,
		...over
	};
}

function commitment(over: Partial<Commitment> & Pick<Commitment, 'discipline' | 'label' | 'days'>) {
	return {
		id: id(200),
		timeOfDay: null,
		durationMinutes: null,
		intensity: null,
		notes: null,
		...over
	} satisfies Commitment;
}

/** What a complete M2 profile may hold and nothing more: one goal and daysPerWeek. */
function minimal(): TrainingProfile {
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
			onboarding: { current: 'review', completed: ['review'], skipped: [], completedAt: AT },
			updatedAt: AT
		},
		bodyWeight: [],
		goals: [goal({ title: 'Get stronger', disciplines: ['strength'] })],
		experience: [],
		baselines: [],
		running: null,
		muayThai: null,
		equipment: null,
		injuries: [],
		exercises: [],
		schedule: {
			daysPerWeek: 3,
			availableDays: [],
			preferredTimes: [],
			sessionMinutes: null,
			constraints: null,
			commitments: [],
			updatedAt: AT
		}
	};
}

const experience = (over: Partial<ExperienceEntry>): ExperienceEntry => ({
	id: id(300),
	discipline: 'strength',
	customLabel: null,
	level: 'intermediate',
	years: 4,
	sessionsPerWeek: 3,
	notes: null,
	updatedAt: AT,
	...over
});

const baseline = (over: Partial<StrengthBaseline>): StrengthBaseline => ({
	id: id(400),
	lift: 'back_squat',
	customLabel: null,
	kind: 'measured',
	source: 'tested',
	value: 140,
	unit: 'kg',
	achievedOn: '2026-10-01',
	setWeight: null,
	setReps: null,
	setRpe: null,
	method: null,
	confidence: null,
	notes: null,
	recordedAt: AT,
	...over
});

const injury = (over: Partial<Injury>): Injury => ({
	id: id(500),
	bodyArea: 'shoulder',
	side: 'left',
	severity: 'moderate',
	notes: 'Hurts when pressing overhead',
	avoid: ['overhead pressing'],
	active: true,
	since: '2026-09-01',
	updatedAt: AT,
	...over
});

/** A hybrid athlete: a fight, a marathon and strength, with something told in every section. */
function hybrid(): TrainingProfile {
	const p = minimal();
	return {
		...p,
		profile: { ...p.profile, nutritionPhase: 'maintenance', weightUnit: 'lb' },
		bodyWeight: [
			{ id: 1, value: 172, unit: 'lb', measuredOn: '2026-10-30', source: 'manual' },
			{ id: 2, value: 77.5, unit: 'kg', measuredOn: '2026-11-02', source: 'manual' }
		],
		goals: [
			goal({
				id: id(101),
				kind: 'event',
				title: 'Fight',
				disciplines: ['muay_thai', 'athletic'],
				priority: 1,
				eventType: 'Muay Thai fight',
				eventDate: '2026-12-12',
				focus: null,
				measure: null
			}),
			goal({
				id: id(102),
				kind: 'event',
				title: 'Marathon',
				disciplines: ['distance_running'],
				priority: 2,
				eventType: 'Marathon',
				eventDate: '2027-04-18',
				focus: null,
				measure: null
			}),
			goal({ id: id(103), title: 'Keep strength', disciplines: ['strength'], priority: 3 })
		],
		experience: [
			experience({ id: id(301), discipline: 'muay_thai', level: 'advanced' }),
			experience({ id: id(302), discipline: 'distance_running', level: 'intermediate' }),
			experience({ id: id(303), discipline: 'strength', level: 'intermediate' }),
			experience({ id: id(304), discipline: 'athletic', level: 'novice' })
		],
		baselines: [
			baseline({ id: id(401) }),
			baseline({
				id: id(402),
				lift: 'bench_press',
				kind: 'estimated',
				source: 'estimate',
				value: 225,
				unit: 'lb'
			})
		],
		running: {
			unit: 'km',
			weeklyDistance: 30,
			runsPerWeek: 3,
			longestRun: 16,
			easyPaceSeconds: 330,
			races: [
				{
					id: id(601),
					distance: '10k',
					customDistance: null,
					distanceMetres: 10000,
					timeSeconds: 2700,
					racedOn: '2026-05-10',
					eventName: 'City 10K'
				},
				{
					id: id(602),
					distance: '5k',
					customDistance: null,
					distanceMetres: 5000,
					timeSeconds: 1260,
					racedOn: null,
					eventName: null
				}
			],
			notes: null,
			updatedAt: AT
		},
		muayThai: { sessionsPerWeek: 2, sparringPerWeek: 1, fights: 3, notes: null, updatedAt: AT },
		equipment: {
			gymType: 'commercial',
			equipment: ['plyo_box', 'barbell'],
			homeEquipment: ['kettlebells'],
			notes: 'Rack is busy after 6pm',
			updatedAt: AT
		},
		injuries: [
			injury({ id: id(501) }),
			injury({ id: id(502), bodyArea: 'knee', side: 'right', avoid: ['jumping'], active: false }),
			injury({ id: id(503), bodyArea: 'lower_back', side: null, severity: 'mild', avoid: [] })
		],
		exercises: [
			{ id: id(701), exercise: 'Box jumps', sentiment: 'like', reason: null },
			{ id: id(702), exercise: 'RDL', sentiment: 'dislike', reason: 'Lower back' }
		],
		schedule: {
			daysPerWeek: 5,
			availableDays: ['sat', 'mon', 'tue', 'wed', 'thu', 'fri'],
			preferredTimes: ['evening', 'varies', 'morning'],
			sessionMinutes: 75,
			constraints: 'Never before 6am',
			commitments: [
				commitment({
					id: id(202),
					discipline: 'muay_thai',
					label: 'Muay Thai class',
					days: ['thu', 'tue'],
					timeOfDay: 'evening',
					intensity: 'hard'
				}),
				commitment({ id: id(201), discipline: 'running', label: 'Run club', days: ['mon'] })
			],
			updatedAt: AT
		}
	};
}

const SOURCES: InputSources = { catalogue: CATALOGUE };
const build = (profile: TrainingProfile, sources: Partial<InputSources> = {}) =>
	buildProgrammingInput(profile, { ...SOURCES, ...sources });

describe('a minimal profile', () => {
	it('normalises without throwing and lists every default it applied', () => {
		const input = build(minimal());
		expect(input).toMatchObject({
			goals: [{ title: 'Get stronger', priority: 1, disciplines: ['strength'] }],
			disciplines: ['strength'],
			experience: { strength: 'new' },
			daysPerWeek: 3,
			availableDays: [...WEEKDAYS],
			preferredTimes: [],
			sessionMinutes: 60,
			equipment: GYM_PRESETS.commercial,
			running: null,
			muayThai: null,
			bodyWeightKg: null
		});
		expect(input.assumptions).toEqual([
			{ ruleKey: 'defaults.available_days', field: 'availableDays', value: 'every_day' },
			{ ruleKey: 'defaults.preferred_times', field: 'preferredTimes', value: 'none' },
			{ ruleKey: 'defaults.session_minutes', field: 'sessionMinutes', value: 60 },
			{ ruleKey: 'defaults.equipment', field: 'equipment', value: 'commercial' },
			{ ruleKey: 'defaults.experience', field: 'experience.strength', value: 'new' }
		]);
	});

	it('applies no default to what the owner told', () => {
		const input = build(hybrid());
		expect(input.assumptions).toEqual([
			{
				ruleKey: 'defaults.commitment_intensity',
				field: 'commitments.0.intensity',
				value: 'moderate'
			},
			{ ruleKey: 'defaults.commitment_minutes', field: 'commitments.0.durationMinutes', value: 60 },
			{ ruleKey: 'defaults.commitment_minutes', field: 'commitments.1.durationMinutes', value: 90 }
		]);
	});

	it('needs daysPerWeek, which completing onboarding requires', () => {
		const p = minimal();
		expect(() => build({ ...p, schedule: { ...p.schedule, daysPerWeek: null } })).toThrow(
			/daysPerWeek/
		);
	});
});

describe('goals', () => {
	it('drops closed goals, keeps paused ones apart and orders the rest by priority', () => {
		const p = minimal();
		p.goals = [
			goal({
				id: id(1),
				title: 'Old meet',
				disciplines: ['powerlifting'],
				status: 'achieved',
				priority: null
			}),
			goal({ id: id(2), title: 'Marathon', disciplines: ['distance_running'], priority: 3 }),
			goal({
				id: id(3),
				title: 'Fight',
				disciplines: ['muay_thai'],
				status: 'paused',
				priority: 1
			}),
			goal({ id: id(4), title: 'Strength', disciplines: ['strength', 'hypertrophy'], priority: 2 }),
			goal({
				id: id(5),
				title: 'Swim',
				disciplines: ['athletic'],
				status: 'dropped',
				priority: null
			})
		];
		const input = build(p);
		expect(input.goals.map((g) => [g.title, g.priority])).toEqual([
			['Strength', 2],
			['Marathon', 3]
		]);
		expect(input.paused.map((g) => g.title)).toEqual(['Fight']);
		expect(input.maintenance).toBe(false);
		expect(input.disciplines).toEqual(['strength', 'hypertrophy', 'distance_running']);
		expect(input.refs).toMatchObject({ goals: [id(4), id(2)], paused: [id(3)] });
		expect(input.assumptions.map((a) => a.ruleKey)).not.toContain('defaults.all_goals_paused');
	});

	it('plans the paused goals at maintenance when every open goal is paused', () => {
		const p = minimal();
		p.goals = [
			goal({
				id: id(1),
				title: 'Marathon',
				disciplines: ['distance_running'],
				status: 'paused',
				priority: 2
			}),
			goal({
				id: id(2),
				title: 'Strength',
				disciplines: ['strength'],
				status: 'paused',
				priority: 1
			})
		];
		const input = build(p);
		expect(input).toMatchObject({ goals: [], maintenance: true });
		expect(input.paused.map((g) => g.title)).toEqual(['Strength', 'Marathon']);
		expect(input.disciplines).toEqual(['strength', 'distance_running']);
		expect(input.refs).toMatchObject({ goals: [], paused: [id(2), id(1)] });
		expect(input.assumptions).toContainEqual({
			ruleKey: 'defaults.all_goals_paused',
			field: 'maintenance',
			value: 'maintenance'
		});
	});

	it('keeps a custom discipline’s name and the dates an event is counted from', () => {
		const p = minimal();
		p.goals = [
			goal({ title: 'Climb V6', disciplines: ['custom'], customDiscipline: 'Bouldering' }),
			goal({
				title: 'Race',
				kind: 'event',
				disciplines: ['running'],
				priority: 2,
				eventType: '10K race',
				eventDate: '2026-12-13'
			})
		];
		const [climb, race] = build(p).goals;
		expect(climb).toMatchObject({ customDiscipline: 'Bouldering', disciplines: ['custom'] });
		expect(race).toMatchObject({ eventType: '10K race', eventDate: '2026-12-13' });
		// Week 1 starts Monday 9 November: the race falls in week 5.
		expect(weeksToEvent(race!, '2026-11-09')).toBe(4);
		expect(weeksToEvent(race!, '2026-12-07')).toBe(0);
		expect(weeksToEvent(climb!, '2026-11-09')).toBeNull();
	});
});

describe('schedule', () => {
	it.each([
		[['varies'], []],
		[['varies', 'morning'], ['morning']],
		[
			['evening', 'morning', 'evening'],
			['morning', 'evening']
		]
	] as const)("preferred times %j give %j: 'varies' is never a distinct time", (told, times) => {
		const p = minimal();
		p.schedule.preferredTimes = [...told];
		const input = build(p);
		expect(input.preferredTimes).toEqual(times);
		expect(input.assumptions.some((a) => a.ruleKey === 'defaults.preferred_times')).toBe(
			times.length === 0
		);
	});

	it('keeps the days told, Monday first, with no default', () => {
		const p = minimal();
		p.schedule.availableDays = ['sun', 'mon', 'wed', 'mon'];
		const input = build(p);
		expect(input.availableDays).toEqual(['mon', 'wed', 'sun']);
		expect(input.assumptions.map((a) => a.field)).not.toContain('availableDays');
	});

	it('gives a commitment with no intensity or duration the defaults, listed by position', () => {
		const p = minimal();
		p.schedule.commitments = [
			commitment({ id: id(1), discipline: 'muay_thai', label: 'Thai class', days: ['thu', 'tue'] }),
			commitment({
				id: id(2),
				discipline: 'strength',
				label: 'CrossFit',
				days: ['mon'],
				durationMinutes: 45,
				intensity: 'hard',
				timeOfDay: 'varies'
			})
		];
		const input = build(p);
		expect(input.commitments).toEqual([
			{
				discipline: 'strength',
				label: 'CrossFit',
				days: ['mon'],
				timeOfDay: 'varies',
				durationMinutes: 45,
				intensity: 'hard'
			},
			{
				discipline: 'muay_thai',
				label: 'Thai class',
				days: ['tue', 'thu'],
				timeOfDay: null,
				durationMinutes: 90,
				intensity: 'moderate'
			}
		]);
		expect(input.refs.commitments).toEqual([id(2), id(1)]);
		expect(input.assumptions.filter((a) => a.field.startsWith('commitments.'))).toEqual([
			{
				ruleKey: 'defaults.commitment_intensity',
				field: 'commitments.1.intensity',
				value: 'moderate'
			},
			{ ruleKey: 'defaults.commitment_minutes', field: 'commitments.1.durationMinutes', value: 90 }
		]);
	});
});

describe('equipment', () => {
	const withKit = (equipment: TrainingProfile['equipment']) => build({ ...minimal(), equipment });
	const kit = (over: Partial<NonNullable<TrainingProfile['equipment']>>) => ({
		gymType: null,
		equipment: [],
		homeEquipment: [],
		notes: null,
		updatedAt: AT,
		...over
	});

	it('is the gym type’s preset, what is ticked and the home kit, in M2’s order', () => {
		const input = withKit(
			kit({ gymType: 'home', equipment: ['plyo_box'], homeEquipment: ['dumbbells', 'barbell'] })
		);
		expect(input.equipment).toEqual(['barbell', 'squat_rack', 'bench', 'dumbbells', 'plyo_box']);
		expect(input.assumptions.map((a) => a.ruleKey)).not.toContain('defaults.equipment');
	});

	it('is what is ticked alone when no gym type is picked, and nothing for no gym', () => {
		expect(withKit(kit({ equipment: ['dumbbells'] })).equipment).toEqual(['dumbbells']);
		const none = withKit(kit({ gymType: 'none' }));
		expect(none.equipment).toEqual([]);
		expect(none.assumptions.map((a) => a.ruleKey)).not.toContain('defaults.equipment');
	});

	it('assumes the commercial preset when nothing is set', () => {
		for (const input of [withKit(null), withKit(kit({}))]) {
			expect(input.equipment).toEqual(GYM_PRESETS[DEFAULTS.equipment.value]);
			expect(input.assumptions).toContainEqual({
				ruleKey: 'defaults.equipment',
				field: 'equipment',
				value: 'commercial'
			});
		}
	});

	it('has presets of M2 equipment, matching M2’s descriptions of each gym type', () => {
		for (const preset of Object.values(GYM_PRESETS)) {
			expect(preset).toEqual(EQUIPMENT.filter((item) => preset.includes(item)));
		}
		expect(GYM_PRESETS.commercial).toEqual(
			expect.arrayContaining(['squat_rack', 'barbell', 'dumbbells', 'cables', 'machines'])
		);
		expect(GYM_PRESETS.strength).toEqual(expect.arrayContaining(['platform', 'specialty_bars']));
		expect(GYM_PRESETS.home).toEqual(expect.arrayContaining(['squat_rack', 'barbell']));
		expect(GYM_PRESETS.minimal).toEqual(expect.arrayContaining(['dumbbells', 'bands']));
		expect(GYM_PRESETS.none).toEqual([]);
	});
});

describe('injuries, preferences and baselines', () => {
	it('keeps active injuries only, with their movements to avoid', () => {
		const p = minimal();
		p.injuries = [
			injury({ id: id(1), bodyArea: 'knee', avoid: ['jumping'], active: false }),
			injury({ id: id(2), avoid: [' overhead pressing ', 'dips', '', 'dips'] })
		];
		expect(build(p).injuries).toEqual([
			{
				bodyArea: 'shoulder',
				side: 'left',
				severity: 'moderate',
				avoid: ['dips', 'overhead pressing']
			}
		]);
	});

	it('names likes and dislikes by key; a linked preference and the same text unlinked agree', () => {
		const own: OwnedExercise = { id: id(9), ...customExercise('Sandbag shouldering') };
		const p = minimal();
		p.exercises = [
			{ id: id(1), exercise: 'RDL', sentiment: 'dislike', reason: null },
			{ id: id(2), exercise: 'sandbag shoulderings', sentiment: 'like', reason: null },
			{ id: id(3), exercise: 'Running intervals', sentiment: 'like', reason: null }
		];
		const unlinked = build(p, { customExercises: [own] });
		expect(unlinked).toMatchObject({ dislikes: ['romanian_deadlift'], likes: [`custom:${id(9)}`] });

		const linked = build(p, {
			customExercises: [own],
			preferences: [
				{ exercise: 'My hinge', sentiment: 'dislike', linked: { key: 'romanian_deadlift' } },
				{ exercise: 'Shouldering', sentiment: 'like', linked: { customId: id(9) } },
				// A link the library no longer has falls back to the text.
				{ exercise: 'Box jumps', sentiment: 'like', linked: { key: 'retired_jump' } }
			]
		});
		expect(linked).toMatchObject({
			dislikes: ['romanian_deadlift'],
			likes: ['box_jump', `custom:${id(9)}`]
		});
		expect(linked.customExercises).toEqual([
			{ key: `custom:${id(9)}`, ...customExercise('Sandbag shouldering') }
		]);
	});

	it('never likes what is also disliked', () => {
		const p = minimal();
		p.exercises = [
			{ id: id(1), exercise: 'Burpees', sentiment: 'like', reason: null },
			{ id: id(2), exercise: 'burpee', sentiment: 'dislike', reason: null }
		];
		expect(build(p)).toMatchObject({ likes: [], dislikes: ['burpee'] });
	});

	it('turns ExerciseRefs into keys and back', () => {
		expect(toExerciseKey({ key: 'back_squat' })).toBe('back_squat');
		expect(toExerciseKey({ customId: id(9) })).toBe(`custom:${id(9)}`);
		expect(toExerciseRef(`custom:${id(9)}`)).toEqual({ customId: id(9) });
		expect(toExerciseRef('back_squat')).toEqual({ key: 'back_squat' });
	});

	it('keeps baselines in kg: estimated stays estimated and blank stays blank', () => {
		expect(build(hybrid()).baselines).toEqual({
			back_squat: { kg: 140, kind: 'measured' },
			front_squat: null,
			bench_press: { kg: 102.058283, kind: 'estimated' },
			deadlift: null,
			overhead_press: null,
			snatch: null,
			clean_and_jerk: null,
			power_clean: null,
			weighted_pull_up: null
		});
		const p = minimal();
		p.baselines = [baseline({ lift: 'custom', customLabel: 'Zercher squat' })];
		expect(Object.values(build(p).baselines)).toEqual(Array(9).fill(null));
	});
});

describe('experience and specifics', () => {
	it('gives the level told in each discipline trained, assuming new where none is told', () => {
		const input = build(hybrid());
		// The top goal's disciplines first: the fight, then the marathon, then strength.
		expect(input.disciplines).toEqual(['muay_thai', 'athletic', 'distance_running', 'strength']);
		expect(input.experience).toEqual({
			muay_thai: 'advanced',
			athletic: 'novice',
			distance_running: 'intermediate',
			strength: 'intermediate'
		});
		const p = hybrid();
		p.experience = p.experience.filter((e) => e.discipline !== 'muay_thai');
		expect(build(p).experience.muay_thai).toBe('new');
		expect(build(p).assumptions).toContainEqual({
			ruleKey: 'defaults.experience',
			field: 'experience.muay_thai',
			value: 'new'
		});
	});

	it('keeps running in metres and seconds per km, and the latest weigh-in in kg', () => {
		const p = hybrid();
		p.running = {
			...p.running!,
			unit: 'mi',
			weeklyDistance: 20,
			longestRun: 10,
			easyPaceSeconds: 540
		};
		const input = build(p);
		expect(input.running).toEqual({
			weeklyMetres: 32186.88,
			runsPerWeek: 3,
			longestRunMetres: 16093.44,
			easyPaceSecondsPerKm: 335.540444,
			races: [
				{ distanceMetres: 10000, timeSeconds: 2700, racedOn: '2026-05-10' },
				{ distanceMetres: 5000, timeSeconds: 1260, racedOn: null }
			]
		});
		expect(input.muayThai).toEqual({ sessionsPerWeek: 2, sparringPerWeek: 1, fights: 3 });
		expect(input.bodyWeightKg).toBe(77.5);
		expect(input.nutritionPhase).toBe('maintenance');
		// Two weigh-ins on the last day: the later entry is the current weight.
		p.bodyWeight.push({
			id: 3,
			value: 170,
			unit: 'lb',
			measuredOn: '2026-11-02',
			source: 'manual'
		});
		expect(build(p).bodyWeightKg).toBe(77.110703);
	});

	it('assumes a time-based running week and technical Muay Thai when nothing is told', () => {
		const p = hybrid();
		p.running = null;
		p.muayThai = null;
		p.schedule.commitments = [];
		const rules = build(p).assumptions.map((a) => a.ruleKey);
		expect(rules).toContain('defaults.running_volume');
		expect(rules).toContain('defaults.muay_thai_sessions');
		// Specifics saved with nothing in them are no specifics at all.
		p.running = {
			...hybrid().running!,
			weeklyDistance: null,
			runsPerWeek: null,
			longestRun: null,
			easyPaceSeconds: null,
			races: []
		};
		p.muayThai = {
			sessionsPerWeek: null,
			sparringPerWeek: null,
			fights: null,
			notes: 'Later',
			updatedAt: AT
		};
		expect(build(p)).toMatchObject({ running: null, muayThai: null });
		expect(build(p).assumptions.map((a) => a.ruleKey)).toEqual(rules);
		// A Muay Thai class on the schedule is how the owner trains it.
		p.schedule.commitments = hybrid().schedule.commitments;
		expect(build(p).assumptions.map((a) => a.ruleKey)).not.toContain('defaults.muay_thai_sessions');
	});

	it('leaves out the specifics of disciplines the goals do not train', () => {
		const p = hybrid();
		p.goals = [goal({ title: 'Strength', disciplines: ['strength'] })];
		const input = build(p);
		expect(input).toMatchObject({
			running: null,
			muayThai: null,
			experience: { strength: 'intermediate' }
		});
		expect(input.assumptions.map((a) => a.ruleKey)).not.toContain('defaults.running_volume');
	});
});

/** `value` with every object's keys reversed and, with `rows`, every list too, at every depth. */
function scramble<T>(value: T, rows = true): T {
	if (Array.isArray(value)) {
		const items = value.map((item: unknown) => scramble(item, rows));
		return (rows ? items.reverse() : items) as T;
	}
	if (value && typeof value === 'object' && !(value instanceof Date)) {
		const entries = Object.entries(value).reverse();
		return Object.fromEntries(entries.map(([k, v]) => [k, scramble(v, rows)])) as T;
	}
	return value;
}

describe('the canonical input and its fingerprint', () => {
	const digest = catalogueDigest(CATALOGUE, []);
	const print = (profile: TrainingProfile, sources: Partial<InputSources> = {}) =>
		fingerprint(build(profile, sources), digest);

	it('is the same for the same profile, whatever the order of its rows or keys', () => {
		const base = build(hybrid());
		expect(build(scramble(hybrid()))).toEqual(base);
		const keysReversed = scramble(base, false);
		expect(JSON.stringify(keysReversed)).not.toBe(JSON.stringify(base));
		expect(fingerprint(keysReversed, digest)).toBe(fingerprint(base, digest));
	});

	it('ignores timestamps, row ids, start dates and the time zone', () => {
		const p = hybrid();
		const renumber = <T extends { id: string }>(rows: T[], from: number) =>
			rows.map((row, n) => ({ ...row, id: id(from + n) }));
		const other: TrainingProfile = {
			...p,
			profile: {
				...p.profile,
				timeZone: 'Pacific/Auckland',
				weightUnit: 'kg',
				distanceUnit: 'mi',
				updatedAt: LATER
			},
			goals: renumber(p.goals, 800).map((g) => ({ ...g, createdAt: LATER, updatedAt: LATER })),
			experience: renumber(p.experience, 810).map((e) => ({ ...e, updatedAt: LATER })),
			baselines: renumber(p.baselines, 820).map((b) => ({
				...b,
				recordedAt: LATER,
				achievedOn: '2025-01-01'
			})),
			injuries: renumber(p.injuries, 830).map((i) => ({
				...i,
				since: '2026-10-20',
				updatedAt: LATER
			})),
			exercises: renumber(p.exercises, 840),
			schedule: {
				...p.schedule,
				commitments: renumber(p.schedule.commitments, 850),
				updatedAt: LATER
			},
			equipment: { ...p.equipment!, updatedAt: LATER }
		};
		expect(build(other).refs).not.toEqual(build(p).refs);
		expect(print(other)).toBe(print(p));
		expect(JSON.stringify(build(other))).not.toMatch(/Auckland|UTC|2026-10-20|2025-01-01|T\d\d:/);
	});

	it.each<[string, (p: TrainingProfile) => void]>([
		['days per week', (p) => (p.schedule.daysPerWeek = 4)],
		['session length', (p) => (p.schedule.sessionMinutes = 60)],
		['a preferred time', (p) => (p.schedule.preferredTimes = ['evening'])],
		['an available day', (p) => p.schedule.availableDays.push('sun')],
		['a commitment day', (p) => (p.schedule.commitments[1]!.days = ['wed'])],
		['goal priorities', (p) => ([p.goals[0]!.priority, p.goals[1]!.priority] = [2, 1])],
		['an event date', (p) => (p.goals[1]!.eventDate = '2027-05-02')],
		['a paused goal', (p) => (p.goals[2]!.status = 'paused')],
		['an experience level', (p) => (p.experience[0]!.level = 'intermediate')],
		['a ticked item', (p) => p.equipment!.equipment.push('sled')],
		['an injury', (p) => (p.injuries[0]!.severity = 'severe')],
		[
			'a dislike',
			(p) =>
				p.exercises.push({ id: id(9), exercise: 'Burpees', sentiment: 'dislike', reason: null })
		],
		['a 1RM', (p) => (p.baselines[0]!.value = 145)],
		['weekly running', (p) => (p.running!.weeklyDistance = 35)],
		['sparring', (p) => (p.muayThai!.sparringPerWeek = 2)],
		['the nutrition phase', (p) => (p.profile.nutritionPhase = 'cut')],
		[
			'body weight',
			(p) =>
				p.bodyWeight.push({
					id: 3,
					value: 78,
					unit: 'kg',
					measuredOn: '2026-11-05',
					source: 'manual'
				})
		]
	])('changes with %s', (_, edit) => {
		const p = hybrid();
		edit(p);
		expect(print(p)).not.toBe(print(hybrid()));
	});

	it('changes with one catalogue entry, one custom exercise or the generator id', () => {
		const own: OwnedExercise = { id: id(9), ...customExercise('Sandbag shouldering') };
		const input = build(hybrid(), { customExercises: [own] });
		const base = catalogueDigest(CATALOGUE, [own]);
		const edited = CATALOGUE.map((e) => (e.key === 'back_squat' ? { ...e, repMax: 10 } : e));
		const renamed: OwnedExercise = { ...own, name: 'Sandbag to shoulder' };

		expect(catalogueDigest(edited, [own])).not.toBe(base);
		expect(fingerprint(input, catalogueDigest(edited, [own]))).not.toBe(fingerprint(input, base));
		expect(catalogueDigest(CATALOGUE, [renamed])).not.toBe(base);
		const withRenamed = build(hybrid(), { customExercises: [renamed] });
		expect(fingerprint(withRenamed, base)).not.toBe(fingerprint(input, base));
		expect(fingerprint(input, base, 'perfo-programming/3')).not.toBe(fingerprint(input, base));
		expect(fingerprint(input, base, GENERATOR_ID)).toBe(fingerprint(input, base));
	});
});

function customExercise(name: string): CustomExercise {
	return {
		name,
		aliases: [],
		pattern: 'carry',
		primaryMuscles: ['glutes'],
		secondaryMuscles: ['upper_back'],
		equipment: [],
		substitutionGroup: null,
		skillLevel: 'beginner',
		repMin: 3,
		repMax: 6,
		defaultSeconds: null,
		unilateral: false,
		measure: 'reps',
		loadType: 'external',
		tags: [],
		disciplines: ['athletic']
	};
}
