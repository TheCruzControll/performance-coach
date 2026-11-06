/**
 * describe.ts: plans in plain words. Every fixture is a valid plan part (the contract's schemas
 * accept it), except where a case says it is malformed, so the words are tested on what plans
 * can hold.
 */
import { describe, expect, it } from 'vitest';
import type * as z from 'zod/mini';
import { TIME_OF_DAY_LABEL, TIMES_OF_DAY } from '../profile/catalog';
import type { TimeOfDay } from '../profile/catalog';
import { convertWeight, DEFAULT_LOAD_INCREMENT, formatWeight, roundToIncrement } from '../units';
import type { WeightUnit } from '../units';
import { validate } from '../validation';
import {
	BASELINE_INSTRUCTION,
	describePrescription,
	describeSegment,
	describeSegments,
	describeSession,
	prescribedLoad,
	SESSION_LINE_EXERCISES
} from './describe';
import {
	runSegmentSchema,
	runSegmentsSchema,
	sessionPlanSchema,
	setPrescriptionSchema
} from './schemas';
import type {
	ExerciseRef,
	OtherSessionPlan,
	RunSegment,
	RunSessionPlan,
	SessionPlan,
	SetPrescription,
	StrengthSessionPlan
} from './types';
import { LOAD_BASES, OTHER_SESSION_KINDS } from './vocabulary';
import type { OtherSessionKind } from './vocabulary';

/** `value`, once `schema` accepts it unchanged; a malformed fixture fails the file. */
function valid<T>(schema: z.ZodMiniType, value: T): T {
	const result = validate(schema, value);
	if (!result.ok) throw new Error(`Not a valid fixture: ${JSON.stringify(result.errors)}`);
	expect(result.data).toEqual(value);
	return value;
}

/** A working set, 3 × 5 @ RPE 7 by feel with 2:00 rest, changed by `over`; not validated. */
const raw = (over: Partial<SetPrescription> = {}): SetPrescription => ({
	role: 'working',
	sets: 3,
	repsMin: 5,
	repsMax: 5,
	seconds: null,
	metres: null,
	targetRpe: 7,
	loadKind: 'rpe_based',
	loadValue: null,
	loadUnit: null,
	loadBasis: null,
	reference1rm: null,
	reference1rmUnit: null,
	restSeconds: 120,
	tempo: null,
	notes: null,
	...over
});
const set = (over: Partial<SetPrescription> = {}) => valid(setPrescriptionSchema, raw(over));

const absolute = (value: number, unit: WeightUnit) =>
	({ loadKind: 'absolute', loadValue: value, loadUnit: unit }) as const;
const percent = (
	fraction: number,
	reference1rm: number,
	reference1rmUnit: WeightUnit,
	loadBasis: 'measured' | 'estimated' = 'measured'
) =>
	({
		loadKind: 'percent_1rm',
		loadValue: fraction,
		loadBasis,
		reference1rm,
		reference1rmUnit
	}) as const;
const fromE1rm = (fraction: number) => ({ loadKind: 'from_e1rm', loadValue: fraction }) as const;
const held = (seconds: number) => ({ repsMin: null, repsMax: null, seconds }) as const;

const KG = { unit: 'kg' } as const;

describe('describePrescription', () => {
	it.each<[string, Partial<SetPrescription>, string]>([
		['sets × reps @ RPE', {}, '3 × 5 @ RPE 7'],
		[
			'a rep range at a half-step RPE',
			{ repsMin: 8, repsMax: 12, targetRpe: 7.5 },
			'3 × 8–12 @ RPE 7.5'
		],
		['no target RPE', { targetRpe: null, ...absolute(60, 'kg') }, '3 × 5'],
		['a held set, as a clock', { ...held(45) }, '3 × 0:45 @ RPE 7'],
		[
			'a held set over a minute',
			{ ...held(90), targetRpe: null, ...absolute(20, 'kg') },
			'3 × 1:30'
		],
		['a carry in metres', { repsMin: null, repsMax: null, metres: 40 }, '3 × 40 m @ RPE 7'],
		['one set', { sets: 1, repsMin: 3, repsMax: 3, targetRpe: 8 }, '1 × 3 @ RPE 8'],
		['a warm-up', { role: 'warm_up', sets: 2, targetRpe: 5 }, '2 × 5 @ RPE 5'],
		[
			'a top set with its load',
			{ role: 'top', sets: 1, ...percent(0.8, 180, 'kg') },
			'1 × 5 @ RPE 7'
		],
		[
			'a back-off from the estimate',
			{ role: 'back_off', sets: 2, targetRpe: null, ...fromE1rm(0.72) },
			'2 × 5'
		],
		['a baseline top set', { role: 'top', sets: 1 }, 'Work up to a set of 5 @ RPE 7'],
		[
			'a baseline ramp of two sets',
			{ role: 'ramp', sets: 2, repsMin: 3, repsMax: 3, targetRpe: 6.5 },
			'Work up to 2 sets of 3 @ RPE 6.5'
		]
	])('reads %s', (_, over, headline) => {
		expect(describePrescription(set(over), KG).headline).toBe(headline);
	});

	describe('the baseline wording and recording instruction', () => {
		it('asks for the weight, reps and RPE on a set that works up to an RPE with no load', () => {
			for (const role of ['top', 'ramp'] as const) {
				const words = describePrescription(set({ role, sets: 1 }), KG);
				expect(words.headline).toBe('Work up to a set of 5 @ RPE 7');
				expect(words.instruction).toBe(BASELINE_INSTRUCTION);
			}
			expect(BASELINE_INSTRUCTION).toMatch(/weight, reps and RPE/);
			expect(BASELINE_INSTRUCTION).toMatch(/1RM can be estimated/);
		});

		it.each<[string, Partial<SetPrescription>]>([
			['an RPE-based accessory', { role: 'working', repsMin: 10, repsMax: 12 }],
			['an RPE-based back-off', { role: 'back_off' }],
			['a top set with a load', { role: 'top', sets: 1, ...percent(0.8, 180, 'kg') }],
			['a top set with an absolute load', { role: 'top', sets: 1, ...absolute(140, 'kg') }],
			['a held top set, which gives no 1RM', { role: 'top', sets: 1, ...held(30) }],
			['a from_e1rm set', { role: 'back_off', ...fromE1rm(0.72) }]
		])('gives no instruction for %s', (_, over) => {
			const words = describePrescription(set(over), KG);
			expect(words.instruction).toBeNull();
			expect(words.headline).not.toMatch(/^Work up/);
		});
	});

	describe('loads, for every load kind in kg and lb', () => {
		it.each<[string, Partial<SetPrescription>, WeightUnit, string | null, string | null]>([
			['absolute kg in kg, as prescribed', absolute(101, 'kg'), 'kg', '101 kg', null],
			['absolute kg in lb, to the 5 lb plates', absolute(100, 'kg'), 'lb', '220 lb', null],
			['absolute lb in lb, as prescribed', absolute(225, 'lb'), 'lb', '225 lb', null],
			['absolute lb in kg, to the 2.5 kg plates', absolute(225, 'lb'), 'kg', '102.5 kg', null],
			[
				'70 % of a measured 180 kg in kg',
				percent(0.7, 180, 'kg'),
				'kg',
				'125 kg',
				'70 % of your measured 1RM'
			],
			[
				'70 % of a measured 180 kg in lb',
				percent(0.7, 180, 'kg'),
				'lb',
				'280 lb',
				'70 % of your measured 1RM'
			],
			[
				'67.5 % of an estimated 315 lb in lb',
				percent(0.675, 315, 'lb', 'estimated'),
				'lb',
				'215 lb',
				'67.5 % of your estimated 1RM'
			],
			[
				'67.5 % of an estimated 315 lb in kg',
				percent(0.675, 315, 'lb', 'estimated'),
				'kg',
				'97.5 kg',
				'67.5 % of your estimated 1RM'
			],
			['rpe_based in kg', {}, 'kg', null, null],
			['rpe_based in lb', {}, 'lb', null, null]
		])('%s', (_, over, unit, load, basis) => {
			const words = describePrescription(set(over), { unit });
			expect([words.load, words.basis]).toEqual([load, basis]);
		});

		it.each<[WeightUnit, string]>([
			['kg', '120 kg'],
			['lb', '265 lb']
		])('from_e1rm in %s: 0.8 of a 150 kg estimate reads %s', (unit, load) => {
			const words = describePrescription(set(fromE1rm(0.8)), { unit, oneRepMaxKg: 150 });
			expect([words.load, words.basis]).toEqual([load, '80 % of your week-1 estimate']);
		});

		it('rounds every computed load exactly as roundToIncrement does, to the default plates', () => {
			const fractions = [0.3, 0.55, 0.675, 0.7, 0.725, 0.85, 0.9, 1];
			for (const unit of ['kg', 'lb'] as const) {
				for (const from of ['kg', 'lb'] as const) {
					for (const oneRm of [57.5, 100, 142.5, 180, 223.3, 317.5, 497.5]) {
						for (const fraction of fractions) {
							const want = roundToIncrement(
								convertWeight(fraction * oneRm, from, unit),
								DEFAULT_LOAD_INCREMENT[unit]
							);
							const p = set(percent(fraction, oneRm, from));
							expect(prescribedLoad(p, { unit })).toBe(want);
							expect(describePrescription(p, { unit }).load).toBe(formatWeight(want, unit));
							if (from !== 'kg') continue;
							const e = set(fromE1rm(fraction));
							expect(prescribedLoad(e, { unit, oneRepMaxKg: oneRm })).toBe(want);
						}
					}
				}
			}
		});
	});

	describe('a load is shown only when it can be computed', () => {
		it.each<[string, number | null | undefined]>([
			['no estimate yet', undefined],
			['a null estimate', null],
			['a zero estimate', 0],
			['a negative estimate', -5],
			['a NaN estimate', Number.NaN],
			['an infinite estimate', Number.POSITIVE_INFINITY]
		])('from_e1rm with %s: no load, only its words', (_, oneRepMaxKg) => {
			for (const unit of ['kg', 'lb'] as const) {
				const p = set({ role: 'back_off', sets: 2, ...fromE1rm(0.72) });
				expect(prescribedLoad(p, { unit, oneRepMaxKg })).toBeNull();
				const words = describePrescription(p, { unit, oneRepMaxKg });
				expect(words.load).toBeNull();
				expect(words.basis).toBe('72 % of your week-1 estimate');
				expect(JSON.stringify(words)).not.toMatch(/\d\s?(kg|lb)\b/);
			}
		});

		it('never gives an RPE-based set a load, even when an estimate is known', () => {
			const words = describePrescription(set(), { unit: 'kg', oneRepMaxKg: 150 });
			expect([words.load, words.basis]).toEqual([null, null]);
		});

		it('takes a percent_1rm load from its own 1RM snapshot, never from the estimate passed', () => {
			const p = set(percent(0.7, 100, 'kg', 'estimated'));
			const words = describePrescription(p, { unit: 'kg', oneRepMaxKg: 150 });
			expect([words.load, words.basis]).toEqual(['70 kg', '70 % of your estimated 1RM']);
		});

		it('gives a malformed percent_1rm row with no snapshot no load, even with an estimate', () => {
			const p = raw({ ...percent(0.7, 100, 'kg'), reference1rm: null, reference1rmUnit: null });
			expect(prescribedLoad(p, { unit: 'kg', oneRepMaxKg: 150 })).toBeNull();
			expect(describePrescription(p, { unit: 'kg', oneRepMaxKg: 150 }).basis).toBe(
				'70 % of your measured 1RM'
			);
		});
	});

	it('never labels an estimated 1RM measured', () => {
		const cases: SetPrescription[] = [
			set(),
			set(absolute(100, 'kg')),
			set(fromE1rm(0.75)),
			...LOAD_BASES.map((basis) => set(percent(0.7, 150, 'kg', basis))),
			// A malformed row with no basis is never presumed measured.
			raw({ ...percent(0.7, 150, 'kg'), loadBasis: null })
		];
		for (const p of cases) {
			for (const oneRepMaxKg of [undefined, 160]) {
				for (const unit of ['kg', 'lb'] as const) {
					const text = JSON.stringify(describePrescription(p, { unit, oneRepMaxKg }));
					const measured = p.loadKind === 'percent_1rm' && p.loadBasis === 'measured';
					expect(text.includes('measured'), JSON.stringify(p)).toBe(measured);
				}
			}
		}
	});

	it.each<[number | null, string | null]>([
		[45, 'Rest 0:45'],
		[90, 'Rest 1:30'],
		[180, 'Rest 3:00'],
		[300, 'Rest 5:00'],
		[0, 'No rest'],
		[null, null]
	])('reads a rest of %s seconds through formatDuration: %s', (restSeconds, rest) => {
		expect(describePrescription(set({ restSeconds }), KG).rest).toBe(rest);
	});

	it('names the tempo when there is one', () => {
		expect(describePrescription(set({ tempo: '31X0' }), KG).tempo).toBe('Tempo 31X0');
		expect(describePrescription(set(), KG).tempo).toBeNull();
	});
});

// ---- Runs -----------------------------------------------------------------------------------

/** A run segment of `kind` changed by `over`, validated. */
const segment = (kind: RunSegment['kind'], over: Partial<RunSegment>): RunSegment =>
	valid(runSegmentSchema, {
		kind,
		repeatGroup: null,
		repeats: null,
		distanceMetres: null,
		durationSeconds: null,
		paceMinSecondsPerKm: null,
		paceMaxSecondsPerKm: null,
		hrZone: null,
		targetRpe: null,
		...over
	});

describe('describeSegment', () => {
	it.each<[string, RunSegment, 'km' | 'mi', string, string | null, string | null]>([
		[
			'a timed warm-up at an RPE',
			segment('warm_up', { durationSeconds: 600, targetRpe: 3 }),
			'km',
			'Warm-up 10:00',
			null,
			'RPE 3'
		],
		[
			'an interval with a pace range, per km',
			segment('interval', {
				distanceMetres: 400,
				paceMinSecondsPerKm: 225,
				paceMaxSecondsPerKm: 240
			}),
			'km',
			'Interval 400 m',
			'3:45–4:00 /km',
			null
		],
		[
			'the same interval for a runner in miles: track metres, pace per mile',
			segment('interval', {
				distanceMetres: 400,
				paceMinSecondsPerKm: 225,
				paceMaxSecondsPerKm: 240
			}),
			'mi',
			'Interval 400 m',
			'6:02–6:26 /mi',
			null
		],
		[
			'a long run in HR zone 2, in km',
			segment('long', { distanceMetres: 16000, hrZone: 2 }),
			'km',
			'Long 16 km',
			null,
			'HR zone 2'
		],
		[
			'a long run in HR zone 2, in miles',
			segment('long', { distanceMetres: 16000, hrZone: 2 }),
			'mi',
			'Long 9.94 mi',
			null,
			'HR zone 2'
		],
		[
			'a distance in a time, with the pace it implies',
			segment('tempo', { distanceMetres: 5000, durationSeconds: 1350 }),
			'km',
			'Tempo 5 km in 22:30',
			'4:30 /km',
			null
		],
		[
			'a distance in a time, in miles',
			segment('tempo', { distanceMetres: 5000, durationSeconds: 1350 }),
			'mi',
			'Tempo 3.11 mi in 22:30',
			'7:15 /mi',
			null
		],
		[
			'a single target pace, by HR zone and RPE',
			segment('steady', {
				durationSeconds: 1200,
				paceMinSecondsPerKm: 300,
				paceMaxSecondsPerKm: 300,
				hrZone: 3,
				targetRpe: 6
			}),
			'km',
			'Steady 20:00',
			'5:00 /km',
			'HR zone 3 · RPE 6'
		],
		[
			'a stated pace range over the pace a time implies',
			segment('tempo', {
				distanceMetres: 5000,
				durationSeconds: 1350,
				paceMinSecondsPerKm: 265,
				paceMaxSecondsPerKm: 275
			}),
			'km',
			'Tempo 5 km in 22:30',
			'4:25–4:35 /km',
			null
		],
		[
			'an easy hour with no target',
			segment('easy', { durationSeconds: 3600 }),
			'km',
			'Easy 1:00:00',
			null,
			null
		]
	])('reads %s', (_, s, distanceUnit, headline, pace, target) => {
		expect(describeSegment(s, { distanceUnit })).toEqual({ headline, pace, target });
	});
});

describe('describeSegments', () => {
	const warmUp = segment('warm_up', { durationSeconds: 600, targetRpe: 3 });
	const coolDown = segment('cool_down', { durationSeconds: 600, hrZone: 2 });
	const rep = (
		group: number,
		repeats: number,
		over: Partial<RunSegment>,
		kind: RunSegment['kind']
	) => segment(kind, { repeatGroup: group, repeats, ...over });
	const run = (...segments: RunSegment[]) => valid(runSegmentsSchema, segments);

	it('groups a repeat group into one step that runs its segments n times', () => {
		const steps = describeSegments(
			run(
				warmUp,
				rep(
					1,
					6,
					{ distanceMetres: 400, paceMinSecondsPerKm: 225, paceMaxSecondsPerKm: 240 },
					'interval'
				),
				rep(1, 6, { durationSeconds: 90, targetRpe: 2 }, 'recovery'),
				coolDown
			),
			{ distanceUnit: 'mi' }
		);
		expect(steps.map((s) => [s.repeats, s.headline])).toEqual([
			[1, 'Warm-up 10:00'],
			[6, '6 × (Interval 400 m + Recovery 1:30)'],
			[1, 'Cool-down 10:00']
		]);
		expect(steps[1]!.segments).toEqual([
			{ headline: 'Interval 400 m', pace: '6:02–6:26 /mi', target: null },
			{ headline: 'Recovery 1:30', pace: null, target: 'RPE 2' }
		]);
	});

	it('keeps two repeat groups apart, and a one-segment group needs no brackets', () => {
		const steps = describeSegments(
			run(
				rep(1, 3, { distanceMetres: 1000 }, 'interval'),
				rep(1, 3, { durationSeconds: 120 }, 'recovery'),
				rep(2, 8, { distanceMetres: 200 }, 'interval')
			),
			{ distanceUnit: 'km' }
		);
		expect(steps.map((s) => s.headline)).toEqual([
			'3 × (Interval 1 km + Recovery 2:00)',
			'8 × Interval 200 m'
		]);
	});

	it('gives every segment of a run without repeats its own step', () => {
		const steps = describeSegments(run(warmUp, coolDown), { distanceUnit: 'km' });
		expect(steps.map((s) => [s.repeats, s.headline])).toEqual([
			[1, 'Warm-up 10:00'],
			[1, 'Cool-down 10:00']
		]);
	});
});

// ---- Sessions -------------------------------------------------------------------------------

const NAMES: Record<string, string> = {
	back_squat: 'Back squat',
	bench_press: 'Bench press',
	barbell_row: 'Barbell row',
	romanian_deadlift: 'Romanian deadlift',
	plank: 'Plank'
};
const CUSTOM = 'e0e0e0e0-0000-4000-8000-000000000003';
const exerciseName = (ref: ExerciseRef) => ('key' in ref ? NAMES[ref.key]! : 'Sled drag');
const LINE = { exerciseName, distanceUnit: 'km' } as const;

const base = {
	date: '2026-11-09',
	timeOfDay: null,
	orderInDay: 1,
	customDiscipline: null,
	intensity: 'moderate',
	estLoad: 300,
	targetRpe: 7,
	source: 'generator',
	commitmentRef: null,
	instructions: null,
	notes: null
} as const;

const strength = (refs: ExerciseRef[], timeOfDay: TimeOfDay | null = null): StrengthSessionPlan =>
	valid(sessionPlanSchema, {
		...base,
		kind: 'strength',
		timeOfDay,
		type: 'strength',
		title: 'Full body A',
		discipline: 'strength',
		estMinutes: 60,
		exercises: refs.map((exercise) => ({
			exercise,
			baselineLift: null,
			superset: null,
			substitutedFrom: null,
			substitutionReason: null,
			instructions: null,
			notes: null,
			sets: [raw()]
		}))
	});

const runSession = (
	type: RunSessionPlan['type'],
	estMinutes: number,
	segments: RunSegment[],
	timeOfDay: TimeOfDay | null = null
): RunSessionPlan =>
	valid(sessionPlanSchema, {
		...base,
		kind: 'run',
		timeOfDay,
		type,
		title: 'Run',
		discipline: 'running',
		estMinutes,
		segments
	});

const other = (
	type: OtherSessionPlan['type'],
	kind: OtherSessionKind,
	durationMinutes: number,
	timeOfDay: TimeOfDay | null = null,
	title = 'Session'
): OtherSessionPlan =>
	valid(sessionPlanSchema, {
		...base,
		kind: 'other',
		timeOfDay,
		type,
		title,
		discipline: type === 'muay_thai' ? 'muay_thai' : type === 'custom' ? 'custom' : 'athletic',
		customDiscipline: type === 'custom' ? title : null,
		estMinutes: durationMinutes,
		details: { kind, durationMinutes, targetRpe: 7, metrics: [], notes: null }
	});

describe('describeSession', () => {
	const keys = (...names: string[]) => names.map((key) => ({ key }));

	it('names a strength session by its exercises, in order, the owner’s own included', () => {
		const session = strength([...keys('back_squat', 'bench_press'), { customId: CUSTOM }]);
		expect(describeSession(session, LINE)).toBe('Back squat · Bench press · Sled drag');
	});

	it('describes a whole planned week of every discipline, as program reads do', () => {
		const week: SessionPlan[] = [
			runSession('interval_run', 45, [segment('warm_up', { durationSeconds: 600 })], 'morning'),
			other('muay_thai', 'class', 90, 'evening'),
			strength(keys('back_squat', 'bench_press', 'barbell_row'), 'varies')
		];
		expect(week.map((s) => describeSession(s, LINE))).toEqual([
			'45 min intervals · Morning',
			'Muay Thai class · 90 min · Evening',
			'Back squat · Bench press · Barbell row'
		]);
	});

	it(`names at most ${SESSION_LINE_EXERCISES} exercises, then counts the rest`, () => {
		const all = keys('back_squat', 'bench_press', 'barbell_row', 'romanian_deadlift', 'plank');
		expect(describeSession(strength(all), LINE)).toBe(
			'Back squat · Bench press · Barbell row · +2 more'
		);
		expect(describeSession(strength(all.slice(0, 4)), LINE)).toBe(
			'Back squat · Bench press · Barbell row · +1 more'
		);
		expect(describeSession(strength(all.slice(0, 3)), LINE)).toBe(
			'Back squat · Bench press · Barbell row'
		);
	});

	it('reads a timed run in minutes, by its type', () => {
		const easy = runSession('easy_run', 45, [segment('easy', { durationSeconds: 2700 })]);
		expect(describeSession(easy, LINE)).toBe('45 min easy run');
	});

	it('reads a run given only in distances in the owner’s distance unit', () => {
		const long = runSession('long_run', 95, [segment('long', { distanceMetres: 16000 })]);
		expect(describeSession(long, LINE)).toBe('16 km long run');
		expect(describeSession(long, { ...LINE, distanceUnit: 'mi' })).toBe('9.94 mi long run');
		const track = runSession('interval_run', 50, [
			segment('warm_up', { distanceMetres: 2000 }),
			segment('interval', { repeatGroup: 1, repeats: 6, distanceMetres: 400 }),
			segment('recovery', { repeatGroup: 1, repeats: 6, distanceMetres: 200 }),
			segment('cool_down', { distanceMetres: 2000 })
		]);
		expect(describeSession(track, LINE)).toBe('7.6 km intervals');
	});

	it('reads a run with any timed segment in its estimated minutes', () => {
		const intervals = runSession('interval_run', 45, [
			segment('warm_up', { durationSeconds: 600 }),
			segment('interval', { repeatGroup: 1, repeats: 6, distanceMetres: 400 }),
			segment('recovery', { repeatGroup: 1, repeats: 6, durationSeconds: 90 })
		]);
		expect(describeSession(intervals, LINE)).toBe('45 min intervals');
	});

	it('reads a Muay Thai class by its format, whatever the commitment is called', () => {
		const muayThai = other('muay_thai', 'class', 90, 'evening', 'Fairtex Tuesday class');
		expect(describeSession(muayThai, LINE)).toBe('Muay Thai class · 90 min · Evening');
	});

	const MUAY_THAI: Record<OtherSessionKind, string> = {
		pad_work: 'Muay Thai pad work · 60 min',
		sparring: 'Muay Thai sparring · 60 min',
		technical: 'Muay Thai technique · 60 min',
		conditioning: 'Muay Thai conditioning · 60 min',
		class: 'Muay Thai class · 60 min',
		mobility: 'Muay Thai mobility · 60 min',
		strength_conditioning: 'Muay Thai S&C · 60 min',
		custom: 'Muay Thai · 60 min'
	};

	it('has a line for every other-session kind', () => {
		expect(Object.keys(MUAY_THAI).sort()).toEqual([...OTHER_SESSION_KINDS].sort());
	});

	it.each(OTHER_SESSION_KINDS)('reads a Muay Thai %s session', (kind) => {
		expect(describeSession(other('muay_thai', kind, 60), LINE)).toBe(MUAY_THAI[kind]);
	});

	it.each<[OtherSessionPlan['type'], OtherSessionKind, number, string]>([
		['strength_class', 'class', 60, 'Strength class · 60 min'],
		['mobility', 'mobility', 30, 'Mobility · 30 min'],
		['strength_conditioning', 'strength_conditioning', 45, 'S&C · 45 min'],
		['conditioning', 'class', 45, 'Conditioning class · 45 min'],
		['custom', 'custom', 90, 'Climbing · 90 min'],
		['custom', 'class', 60, 'Climbing · 60 min']
	])('never repeats itself: a %s session of kind %s', (type, kind, minutes, line) => {
		expect(describeSession(other(type, kind, minutes, null, 'Climbing'), LINE)).toBe(line);
	});

	describe('the time of day', () => {
		const sessions = {
			strength: (t: TimeOfDay | null) => strength(keys('back_squat', 'bench_press'), t),
			run: (t: TimeOfDay | null) =>
				runSession('easy_run', 45, [segment('easy', { durationSeconds: 2700 })], t),
			other: (t: TimeOfDay | null) => other('muay_thai', 'class', 90, t)
		};
		const bare = {
			strength: 'Back squat · Bench press',
			run: '45 min easy run',
			other: 'Muay Thai class · 90 min'
		};

		it.each(Object.keys(sessions) as (keyof typeof sessions)[])(
			'ends a %s line when it is known, and never for "varies"',
			(kind) => {
				expect(describeSession(sessions[kind](null), LINE)).toBe(bare[kind]);
				for (const time of TIMES_OF_DAY) {
					const want =
						time === 'varies' ? bare[kind] : `${bare[kind]} · ${TIME_OF_DAY_LABEL[time]}`;
					expect(describeSession(sessions[kind](time), LINE)).toBe(want);
				}
			}
		);
	});
});
