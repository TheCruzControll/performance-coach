/**
 * interference.ts: the concurrent-training rules as pure, data-driven checks. Every fixture is a
 * session the program-plan contract accepts (sessionPlanSchema), in the week of Monday
 * 9 November 2026.
 */
import { describe, expect, it } from 'vitest';
import { addDays, weekdayOf } from '../calendar';
import { WEEKDAY_INFO, WEEKDAYS } from '../profile/catalog';
import type { Discipline, Weekday } from '../profile/catalog';
import { sessionPlanSchema } from '../training/schemas';
import type {
	OtherSessionPlan,
	PlannedExercisePlan,
	RunSegment,
	RunSessionPlan,
	SessionPlan,
	SetPrescription,
	StrengthSessionPlan
} from '../training/types';
import type {
	OtherSessionKind,
	RunSegmentKind,
	SessionIntensity,
	SessionType
} from '../training/vocabulary';
import { validate } from '../validation';
import {
	BLOCKS_EDIT,
	catalogueTraits,
	checkWeek,
	demandOf,
	INTERFERENCE,
	INTERFERENCE_RULES
} from './interference';
import type {
	CheckOptions,
	ExerciseTraits,
	InterferenceRule,
	InterferenceSession,
	TraitsOf
} from './interference';

// ---- Fixtures -------------------------------------------------------------------------------

const MONDAY = '2026-11-09';
const on = (day: Weekday) => addDays(MONDAY, WEEKDAYS.indexOf(day));
const COMMITMENT = {
	source: 'commitment',
	commitmentRef: '5b0f4a52-8a43-4c1e-9d6b-2f0e7c3a9b10'
} as const;
/** One of the owner's own exercises. */
const OWN = '9a1c3e5f-7b2d-4f60-8e14-0c2b4d6f8a19';

/** `session`, once the contract's schema accepts it. */
function valid<S extends SessionPlan>(session: S): S {
	const result = validate(sessionPlanSchema, session);
	if (!result.ok) throw new Error(`Not a valid session: ${JSON.stringify(result.errors)}`);
	return session;
}

type Shared = Omit<StrengthSessionPlan, 'kind' | 'exercises'>;
const RPE: Record<SessionIntensity, number> = { easy: 4, moderate: 6, hard: 8, very_hard: 9 };

/** A generated, moderate hour on `day`, changed by `over`. */
function shared(day: Weekday, title: string, type: SessionType, over: Partial<Shared>): Shared {
	const intensity = over.intensity ?? 'moderate';
	const estMinutes = over.estMinutes ?? 60;
	const targetRpe = over.targetRpe ?? RPE[intensity];
	return {
		date: on(day),
		timeOfDay: null,
		orderInDay: 1,
		type,
		title,
		discipline: 'strength',
		customDiscipline: null,
		intensity,
		estMinutes,
		estLoad: estMinutes * targetRpe,
		targetRpe,
		source: 'generator',
		commitmentRef: null,
		instructions: null,
		notes: null,
		...over
	};
}

/** A working set of 3 × 5 @ RPE 7 by feel, changed by `over`. */
const set = (over: Partial<SetPrescription> = {}): SetPrescription => ({
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

const lift = (key: string, ...sets: SetPrescription[]): PlannedExercisePlan => ({
	exercise: { key },
	baselineLift: null,
	superset: null,
	substitutedFrom: null,
	substitutionReason: null,
	instructions: null,
	notes: null,
	sets: sets.length > 0 ? sets : [set()]
});

/** A hard strength session unless `over` says otherwise. */
const strength = (
	day: Weekday,
	title: string,
	exercises: PlannedExercisePlan[],
	over: Partial<Shared> = {}
) =>
	valid<StrengthSessionPlan>({
		kind: 'strength',
		...shared(day, title, 'strength', { intensity: 'hard', ...over }),
		exercises
	});

/** A timed segment; one in a repeat group runs 6 times. */
const segment = (
	kind: RunSegmentKind,
	seconds: number,
	group: number | null = null
): RunSegment => ({
	kind,
	repeatGroup: group,
	repeats: group === null ? null : 6,
	distanceMetres: null,
	durationSeconds: seconds,
	paceMinSecondsPerKm: null,
	paceMaxSecondsPerKm: null,
	hrZone: null,
	targetRpe: null
});

const run = (
	day: Weekday,
	title: string,
	type: SessionType,
	segments: RunSegment[],
	over: Partial<Shared> = {}
) =>
	valid<RunSessionPlan>({
		kind: 'run',
		...shared(day, title, type, { discipline: 'running', ...over }),
		segments
	});

function other(
	day: Weekday,
	title: string,
	type: SessionType,
	kind: OtherSessionKind,
	over: Partial<Shared> = {}
) {
	const base = shared(day, title, type, over);
	const details = {
		kind,
		durationMinutes: base.estMinutes,
		targetRpe: base.targetRpe,
		metrics: [],
		notes: null
	};
	return valid<OtherSessionPlan>({ kind: 'other', ...base, details });
}

/** Heavy squats: back squat 4 × 5 @ RPE 8, then Romanian deadlifts, in a hard session. */
const lowerA = (day: Weekday, over: Partial<Shared> = {}) =>
	strength(
		day,
		'Lower A',
		[
			lift('back_squat', set({ sets: 4, targetRpe: 8 })),
			lift('romanian_deadlift', set({ repsMin: 8, repsMax: 8 }))
		],
		over
	);

/** The owner's hard Muay Thai class, in the evening. */
const sparring = (day: Weekday, over: Partial<Shared> = {}) =>
	other(day, 'Muay Thai sparring', 'muay_thai', 'sparring', {
		discipline: 'muay_thai',
		intensity: 'hard',
		estMinutes: 90,
		timeOfDay: 'evening',
		...COMMITMENT,
		...over
	});

/** The owner's light Muay Thai class, in the evening. */
const technique = (day: Weekday, over: Partial<Shared> = {}) =>
	other(day, 'Muay Thai technique', 'muay_thai', 'technical', {
		discipline: 'muay_thai',
		intensity: 'easy',
		timeOfDay: 'evening',
		...COMMITMENT,
		...over
	});

/** The owner's hard strength class: the class sets its content. */
const strengthClass = (day: Weekday, over: Partial<Shared> = {}) =>
	other(day, 'Strength class', 'strength_class', 'class', {
		intensity: 'hard',
		...COMMITMENT,
		...over
	});

const longRun = (day: Weekday, over: Partial<Shared> = {}) =>
	run(day, 'Long run', 'long_run', [segment('long', 100 * 60)], { estMinutes: 100, ...over });

const intervals = (day: Weekday, over: Partial<Shared> = {}) =>
	run(
		day,
		'Intervals',
		'interval_run',
		[
			segment('warm_up', 600),
			segment('interval', 180, 1),
			segment('recovery', 120, 1),
			segment('cool_down', 600)
		],
		{ intensity: 'hard', estMinutes: 50, ...over }
	);

const tempoRun = (day: Weekday, over: Partial<Shared> = {}) =>
	run(
		day,
		'Tempo run',
		'tempo_run',
		[segment('warm_up', 600), segment('tempo', 1200), segment('cool_down', 600)],
		{ intensity: 'hard', estMinutes: 40, ...over }
	);

const easyRun = (day: Weekday, over: Partial<Shared> = {}) =>
	run(day, 'Easy run', 'easy_run', [segment('easy', 40 * 60)], {
		intensity: 'easy',
		estMinutes: 40,
		...over
	});

const ownSquat: ExerciseTraits = {
	pattern: 'squat',
	primaryMuscles: ['quads', 'glutes'],
	tags: ['compound']
};

/** The demands that hold, in alphabetical order. */
const flags = (session: InterferenceSession, traitsOf?: TraitsOf) =>
	Object.entries(demandOf(session, traitsOf))
		.filter(([, holds]) => holds)
		.map(([demand]) => demand)
		.sort();

const byRule = (rule: InterferenceRule, sessions: InterferenceSession[], options?: CheckOptions) =>
	checkWeek(sessions, options).filter((violation) => violation.rule === rule);

/** Every order of `items`. */
function* permutations<T>(items: readonly T[]): Generator<T[]> {
	if (items.length <= 1) {
		yield [...items];
		return;
	}
	for (const [i, item] of items.entries()) {
		for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) {
			yield [item, ...rest];
		}
	}
}

const ROOM = 'Hard days back to back, though the week has room to keep them apart';

// ---- demandOf -------------------------------------------------------------------------------

describe('demandOf', () => {
	it('reads heavy squats in a hard session as heavy lower body', () => {
		expect(flags(lowerA('mon'))).toEqual(['hard', 'heavyLower']);
	});

	it("reads a compound lift at a heavy set as heavy, whatever the session's intensity", () => {
		const moderate = { intensity: 'moderate' } as const;
		const atRpe = lift('back_squat', set({ repsMin: 3, repsMax: 3, targetRpe: 8.5 }));
		const atPercent: PlannedExercisePlan = {
			...lift(
				'back_squat',
				set({
					sets: 1,
					repsMin: 3,
					repsMax: 3,
					targetRpe: null,
					loadKind: 'percent_1rm',
					loadValue: 0.85,
					loadBasis: 'measured',
					reference1rm: 180,
					reference1rmUnit: 'kg'
				})
			),
			baselineLift: 'back_squat'
		};
		expect(flags(strength('mon', 'Squat', [atRpe], moderate))).toEqual(['hard', 'heavyLower']);
		expect(flags(strength('mon', 'Squat', [atPercent], moderate))).toEqual(['hard', 'heavyLower']);
		// Moderate sets of a compound lift, and a hard set of a machine isolation, are not heavy.
		expect(flags(strength('mon', 'Squat', [lift('back_squat')], moderate))).toEqual([]);
		const isolation = lift('leg_extension', set({ repsMin: 12, repsMax: 12, targetRpe: 9 }));
		expect(flags(strength('mon', 'Legs', [isolation], moderate))).toEqual([]);
	});

	it('reads high-volume leg work as heavy lower body at any load, counting hard sets only', () => {
		/** Leg extensions, then 3 × 12 curls and 3 × 15 calf raises, all at `targetRpe`. */
		const legs = (extensions: number, extra: Partial<SetPrescription> | null, targetRpe = 7) =>
			strength(
				'mon',
				'Legs',
				[
					lift(
						'leg_extension',
						...(extra === null ? [] : [set({ sets: 2, ...extra })]),
						set({ sets: extensions, repsMin: 12, repsMax: 12, targetRpe })
					),
					lift('lying_leg_curl', set({ repsMin: 12, repsMax: 12, targetRpe })),
					lift('standing_calf_raise', set({ repsMin: 15, repsMax: 15, targetRpe }))
				],
				{ intensity: 'moderate' }
			);
		const enough = INTERFERENCE.highVolumeHardSets - 6;
		expect(flags(legs(enough, null))).toEqual(['hard', 'heavyLower']);
		expect(flags(legs(enough - 1, null))).toEqual([]);
		// Warm-ups and a ramp's climb are not working sets (isHardSet), nor are sets below RPE 7 hard.
		expect(flags(legs(enough - 1, { role: 'warm_up', targetRpe: 5 }))).toEqual([]);
		expect(flags(legs(enough - 1, { role: 'ramp' }))).toEqual([]);
		expect(flags(legs(enough, null, 6.5))).toEqual([]);
	});

	it('reads a hard upper-body day with a leg accessory as heavy upper body only', () => {
		const upper = strength('mon', 'Upper A', [
			lift('bench_press', set({ sets: 4, targetRpe: 8 })),
			lift('barbell_row', set({ repsMin: 8, repsMax: 8 })),
			lift('leg_extension', set({ repsMin: 12, repsMax: 12 }))
		]);
		expect(flags(upper)).toEqual(['hard', 'heavyUpper']);
	});

	it('never counts mobility, nor an exercise it has no traits for', () => {
		const hold = set({ sets: 12, repsMin: null, repsMax: null, seconds: 60 });
		expect(flags(strength('mon', 'Hips', [lift('deep_squat_hold', hold)]))).toEqual(['hard']);
		const own = strength('mon', 'My squats', [
			{ ...lift('back_squat'), exercise: { customId: OWN } }
		]);
		expect(flags(own)).toEqual(['hard']);
		expect(flags(own, (ref) => ('customId' in ref ? ownSquat : undefined))).toEqual([
			'hard',
			'heavyLower'
		]);
	});

	it('reads Muay Thai as hard combat when hard and sparring at any intensity, a light class as easy', () => {
		const pads = other('tue', 'Pad work', 'muay_thai', 'pad_work', {
			discipline: 'muay_thai',
			intensity: 'hard'
		});
		expect(flags(pads)).toEqual(['hard', 'hardCombat', 'veryDemanding']);
		expect(flags(sparring('tue', { intensity: 'moderate' }))).toEqual([
			'hard',
			'hardCombat',
			'veryDemanding'
		]);
		expect(flags(technique('tue'))).toEqual(['easy']);
		expect(flags(technique('tue', { intensity: 'moderate' }))).toEqual([]);
	});

	it('reads a long run by type or length, and intervals by type, segment or a hard running club', () => {
		expect(flags(longRun('sun'))).toEqual(['hard', 'longRun', 'veryDemanding']);
		expect(flags(easyRun('sun', { estMinutes: INTERFERENCE.longRunMinutes }))).toEqual([
			'hard',
			'longRun',
			'veryDemanding'
		]);
		expect(flags(intervals('tue'))).toEqual(['hard', 'intervals']);
		const fartlek = run('tue', 'Fartlek', 'easy_run', [
			segment('easy', 600),
			segment('interval', 60, 1),
			segment('easy', 60, 1)
		]);
		expect(flags(fartlek)).toEqual(['hard', 'intervals']);
		const club = (intensity: SessionIntensity) =>
			run('wed', 'Running club', 'tempo_run', [segment('steady', 3600)], {
				intensity,
				...COMMITMENT
			});
		expect(flags(club('hard'))).toEqual(['hard', 'intervals']);
		expect(flags(club('moderate'))).toEqual([]);
	});

	it.each<[Discipline, string[]]>([
		['powerlifting', ['hard', 'veryDemanding']],
		['weightlifting', ['hard', 'veryDemanding']],
		['strength', ['hard', 'veryDemanding']],
		['hypertrophy', ['hard', 'veryDemanding']],
		['athletic', ['hard', 'veryDemanding']],
		['custom', ['hard', 'veryDemanding']],
		['running', ['hard', 'intervals']],
		['distance_running', ['hard', 'intervals']],
		['muay_thai', ['hard', 'hardCombat', 'veryDemanding']]
	])(
		'reads a hard %s commitment by its discipline, as the class sets its content',
		(discipline, demands) => {
			const session = other('wed', 'Class', 'custom', 'class', {
				discipline,
				customDiscipline: discipline === 'custom' ? 'Climbing' : null,
				intensity: 'hard',
				...COMMITMENT
			});
			expect(flags(session)).toEqual(demands);
			expect(flags({ ...session, intensity: 'moderate' })).toEqual([]);
		}
	);

	it('reads a very hard session as very demanding on its own, and hard lifting as only hard', () => {
		expect(flags(lowerA('mon', { intensity: 'very_hard' }))).toEqual([
			'hard',
			'heavyLower',
			'veryDemanding'
		]);
		const conditioning = other('wed', 'S&C', 'strength_conditioning', 'strength_conditioning', {
			discipline: 'athletic',
			intensity: 'hard'
		});
		expect(flags(conditioning)).toEqual(['hard']);
	});

	it('reads easy by intensity or type, only with nothing hard about it', () => {
		expect(flags(easyRun('wed'))).toEqual(['easy']);
		expect(flags(easyRun('wed', { intensity: 'moderate' }))).toEqual(['easy']);
		expect(
			flags(other('wed', 'Mobility', 'mobility', 'mobility', { discipline: 'athletic' }))
		).toEqual(['easy']);
		const heavy = strength('wed', 'Squat', [lift('back_squat', set({ targetRpe: 8.5 }))], {
			intensity: 'easy'
		});
		expect(flags(heavy)).toEqual(['hard', 'heavyLower']);
	});

	it("takes a key's traits from the catalogue, and none for the owner's own exercises", () => {
		expect(catalogueTraits({ key: 'back_squat' })).toMatchObject({
			pattern: 'squat',
			tags: expect.arrayContaining(['compound'])
		});
		expect(catalogueTraits({ key: 'not_in_the_catalogue' })).toBeUndefined();
		expect(catalogueTraits({ customId: OWN })).toBeUndefined();
	});
});

// ---- checkWeek ------------------------------------------------------------------------------

describe('checkWeek', () => {
	it('finds nothing in an empty week', () => {
		expect(checkWeek([])).toEqual([]);
	});

	describe('heavy lower body the day before hard Muay Thai or a long run', () => {
		it("is 'avoid' for squats on Monday before Tuesday sparring, not before a light class", () => {
			const squats = lowerA('mon');
			const spar = sparring('tue');
			expect(checkWeek([spar, squats])).toEqual([
				{
					rule: 'heavy_lower_before_hard',
					severity: 'avoid',
					days: [on('mon'), on('tue')],
					sessions: [squats, spar],
					message:
						'Heavy lower body the day before hard Muay Thai: Lower A on Monday, then Muay Thai sparring on Tuesday.'
				},
				{
					rule: 'hard_days_apart',
					severity: 'prefer',
					days: [on('mon'), on('tue')],
					sessions: [squats, spar],
					message: `${ROOM}: Lower A on Monday, then Muay Thai sparring on Tuesday.`
				}
			]);
			expect(checkWeek([lowerA('mon'), technique('tue')])).toEqual([]);
		});

		it("is 'avoid' the day before a long run", () => {
			const legs = lowerA('sat');
			const long = longRun('sun');
			expect(byRule('heavy_lower_before_hard', [legs, long])).toEqual([
				{
					rule: 'heavy_lower_before_hard',
					severity: 'avoid',
					days: [on('sat'), on('sun')],
					sessions: [legs, long],
					message:
						'Heavy lower body the day before a long run: Lower A on Saturday, then Long run on Sunday.'
				}
			]);
		});

		it('lets heavy lower body follow hard Muay Thai, or come two days before it', () => {
			expect(byRule('heavy_lower_before_hard', [sparring('tue'), lowerA('wed')])).toEqual([]);
			expect(byRule('heavy_lower_before_hard', [lowerA('mon'), sparring('wed')])).toEqual([]);
		});

		it("reads the owner's own exercises through the lookup it is given", () => {
			const own = strength('mon', 'My squats', [
				{ ...lift('back_squat'), exercise: { customId: OWN } }
			]);
			expect(byRule('heavy_lower_before_hard', [own, sparring('tue')])).toEqual([]);
			const traitsOf: TraitsOf = () => ownSquat;
			expect(byRule('heavy_lower_before_hard', [own, sparring('tue')], { traitsOf })).toHaveLength(
				1
			);
		});
	});

	describe('intervals the day after a very demanding day', () => {
		it("is 'avoid' after a long run", () => {
			const long = longRun('sat');
			const reps = intervals('sun');
			expect(checkWeek([long, reps])).toEqual([
				{
					rule: 'intervals_after_very_demanding',
					severity: 'avoid',
					days: [on('sat'), on('sun')],
					sessions: [long, reps],
					message:
						'Intervals the day after a very demanding day: Long run on Saturday, then Intervals on Sunday.'
				},
				{
					rule: 'hard_days_apart',
					severity: 'prefer',
					days: [on('sat'), on('sun')],
					sessions: [long, reps],
					message: `${ROOM}: Long run on Saturday, then Intervals on Sunday.`
				}
			]);
		});

		it('counts a hard strength-class commitment as very demanding, and a moderate one not', () => {
			const strong = strengthClass('wed');
			const reps = intervals('thu');
			expect(byRule('intervals_after_very_demanding', [strong, reps])).toEqual([
				{
					rule: 'intervals_after_very_demanding',
					severity: 'avoid',
					days: [on('wed'), on('thu')],
					sessions: [strong, reps],
					message:
						'Intervals the day after a very demanding day: Strength class on Wednesday, then Intervals on Thursday.'
				}
			]);
			const moderate = strengthClass('wed', { intensity: 'moderate' });
			expect(byRule('intervals_after_very_demanding', [moderate, reps])).toEqual([]);
		});

		it('counts a day of two hard sessions as very demanding, and names them both', () => {
			const legs = lowerA('mon', { timeOfDay: 'morning' });
			const tempo = tempoRun('mon', { timeOfDay: 'evening', orderInDay: 2 });
			const reps = intervals('tue');
			expect(byRule('intervals_after_very_demanding', [reps, tempo, legs])).toEqual([
				{
					rule: 'intervals_after_very_demanding',
					severity: 'avoid',
					days: [on('mon'), on('tue')],
					sessions: [legs, tempo, reps],
					message:
						'Intervals the day after a very demanding day: Lower A and Tempo run on Monday, then Intervals on Tuesday.'
				}
			]);
			// One hard session alone is not a very demanding day.
			expect(byRule('intervals_after_very_demanding', [legs, reps])).toEqual([]);
		});

		it('lets intervals come two days after a very demanding day, or the day before it', () => {
			expect(byRule('intervals_after_very_demanding', [longRun('fri'), intervals('sun')])).toEqual(
				[]
			);
			expect(byRule('intervals_after_very_demanding', [intervals('sat'), longRun('sun')])).toEqual(
				[]
			);
		});

		it('checks across a week boundary when it is given both weeks', () => {
			const nextMonday = addDays(MONDAY, 7);
			const reps = intervals('mon', { date: nextMonday });
			expect(byRule('intervals_after_very_demanding', [reps, longRun('sun')])).toEqual([
				expect.objectContaining({
					days: [on('sun'), nextMonday],
					message:
						'Intervals the day after a very demanding day: Long run on Sunday, then Intervals on Monday.'
				})
			]);
		});
	});

	describe('hard days apart', () => {
		it("is 'prefer' for back-to-back hard days when the week has room to keep them apart", () => {
			const legs = lowerA('mon');
			const reps = intervals('tue');
			expect(checkWeek([legs, reps])).toEqual([
				{
					rule: 'hard_days_apart',
					severity: 'prefer',
					days: [on('mon'), on('tue')],
					sessions: [legs, reps],
					message: `${ROOM}: Lower A on Monday, then Intervals on Tuesday.`
				}
			]);
		});

		it('leaves back-to-back hard days alone when the hard days cannot all sit apart', () => {
			// Fixed commitments on Tuesday and Wednesday cannot move apart.
			const fixed = [sparring('tue'), strengthClass('wed'), lowerA('fri')];
			expect(byRule('hard_days_apart', fixed)).toEqual([]);
			// Seven days hold at most four hard days with an easier day between each.
			const weekdays = ['mon', 'tue', 'wed', 'thu', 'fri'] as const;
			expect(checkWeek(weekdays.map((day) => tempoRun(day)))).toEqual([]);
			const four = weekdays.slice(0, 4).map((day) => tempoRun(day));
			expect(byRule('hard_days_apart', four).map((violation) => violation.days)).toEqual([
				[on('mon'), on('tue')],
				[on('tue'), on('wed')],
				[on('wed'), on('thu')]
			]);
		});

		it('takes two fixed hard days in a row as given, and still keeps the others apart', () => {
			// Muay Thai on Monday and Tuesday stays; the tempo runs would sit apart on Thursday and Saturday.
			const tempo = [tempoRun('thu'), tempoRun('fri')];
			expect(checkWeek([sparring('mon'), sparring('tue'), ...tempo])).toEqual([
				{
					rule: 'hard_days_apart',
					severity: 'prefer',
					days: [on('thu'), on('fri')],
					sessions: tempo,
					message: `${ROOM}: Tempo run on Thursday, then Tempo run on Friday.`
				}
			]);
		});

		it('keeps a hard day where it is when its date is not open', () => {
			const week = [lowerA('mon'), intervals('tue')];
			const open = (...days: Weekday[]) => ({ openDates: days.map((day) => on(day)) });
			// Only Monday and Tuesday are free: the two hard days cannot sit apart.
			expect(byRule('hard_days_apart', week, open('mon', 'tue'))).toEqual([]);
			// With Wednesday too, Monday and Wednesday would do.
			expect(byRule('hard_days_apart', week, open('mon', 'tue', 'wed'))).toHaveLength(1);
			// Monday has passed, and Tuesday's intervals can still move to Wednesday or later.
			const later = open('tue', 'wed', 'thu', 'fri', 'sat', 'sun');
			expect(byRule('hard_days_apart', week, later)).toHaveLength(1);
			// Neither can move.
			expect(byRule('hard_days_apart', week, open())).toEqual([]);
		});
	});

	describe('order within a day', () => {
		it('orders a morning run and an evening class by their times, not their order numbers', () => {
			const reps = intervals('wed', { timeOfDay: 'morning', orderInDay: 2 });
			const evening = strengthClass('wed', { timeOfDay: 'evening' });
			expect(byRule('same_day_order', [evening, reps])).toEqual([]);
			const morning = strengthClass('wed', { timeOfDay: 'morning', orderInDay: 2 });
			const late = intervals('wed', { timeOfDay: 'evening' });
			expect(byRule('same_day_order', [late, morning])).toEqual([
				{
					rule: 'same_day_order',
					severity: 'prefer',
					days: [on('wed')],
					sessions: [morning, late],
					message:
						'A very demanding session before intervals on the same day: Strength class, then Intervals, on Wednesday.'
				}
			]);
			// Without both times ('varies' is none), the order in the day decides.
			const varies = strengthClass('wed', { timeOfDay: 'varies' });
			expect(byRule('same_day_order', [varies, reps])).toHaveLength(1);
		});

		it('lets an easy run come before heavy lower body, the same day or the day before', () => {
			const morning = easyRun('mon', { timeOfDay: 'morning' });
			const evening = lowerA('mon', { timeOfDay: 'evening', orderInDay: 2 });
			expect(checkWeek([evening, morning])).toEqual([]);
			expect(checkWeek([easyRun('mon'), lowerA('tue')])).toEqual([]);
			expect(checkWeek([lowerA('mon'), easyRun('tue')])).toEqual([]);
		});

		it("is 'prefer' for heavy lower body before hard Muay Thai or a long run, not after", () => {
			const legs = lowerA('tue', { timeOfDay: 'morning' });
			const spar = sparring('tue', { orderInDay: 2 });
			expect(checkWeek([spar, legs])).toEqual([
				{
					rule: 'same_day_order',
					severity: 'prefer',
					days: [on('tue')],
					sessions: [legs, spar],
					message:
						'Heavy lower body before hard Muay Thai on the same day: Lower A, then Muay Thai sparring, on Tuesday.'
				}
			]);
			const after = lowerA('tue', { timeOfDay: 'evening', orderInDay: 2 });
			expect(checkWeek([after, sparring('tue', { timeOfDay: 'morning' })])).toEqual([]);
			const long = longRun('sun', { timeOfDay: 'afternoon', orderInDay: 2 });
			expect(byRule('same_day_order', [long, lowerA('sun', { timeOfDay: 'morning' })])).toEqual([
				expect.objectContaining({
					message:
						'Heavy lower body before a long run on the same day: Lower A, then Long run, on Sunday.'
				})
			]);
		});
	});

	it("returns the caller's own sessions, so a stored session keeps its lineage", () => {
		const stored = [
			{ ...sparring('tue'), lineage: 'b' },
			{ ...lowerA('mon'), lineage: 'a' }
		];
		const [first] = checkWeek(stored);
		expect(first?.sessions.map((session) => session.lineage)).toEqual(['a', 'b']);
		expect(first?.sessions[1]).toBe(stored[0]);
	});
});

// ---- A whole week ---------------------------------------------------------------------------

describe('checkWeek on a hybrid week', () => {
	/** Strength, a long run and Muay Thai, breaking every rule once or twice. */
	const week = () => [
		lowerA('mon', { timeOfDay: 'morning' }),
		sparring('mon', { orderInDay: 2 }),
		intervals('tue'),
		easyRun('wed'),
		technique('fri'),
		lowerA('sat', { title: 'Lower B' }),
		longRun('sun')
	];

	it('lists every rule broken, by first day and then in the order of the rules', () => {
		expect(checkWeek(week()).map((violation) => [violation.rule, violation.message])).toEqual([
			[
				'intervals_after_very_demanding',
				'Intervals the day after a very demanding day: Lower A and Muay Thai sparring on Monday, then Intervals on Tuesday.'
			],
			[
				'hard_days_apart',
				`${ROOM}: Lower A and Muay Thai sparring on Monday, then Intervals on Tuesday.`
			],
			[
				'same_day_order',
				'Heavy lower body before hard Muay Thai on the same day: Lower A, then Muay Thai sparring, on Monday.'
			],
			[
				'heavy_lower_before_hard',
				'Heavy lower body the day before a long run: Lower B on Saturday, then Long run on Sunday.'
			],
			['hard_days_apart', `${ROOM}: Lower B on Saturday, then Long run on Sunday.`]
		]);
	});

	it('names the days and the sessions in every message', () => {
		for (const violation of checkWeek(week())) {
			for (const day of violation.days) {
				expect(violation.message).toContain(WEEKDAY_INFO[weekdayOf(day)].label);
			}
			for (const session of violation.sessions) expect(violation.message).toContain(session.title);
		}
	});

	it('is deterministic and independent of input order, and never reorders its input', () => {
		const sessions = week();
		const result = checkWeek(sessions);
		for (const order of permutations(sessions)) expect(checkWeek(order)).toEqual(result);
		const reversed = [...sessions].reverse();
		const copy = [...reversed];
		checkWeek(reversed);
		expect(reversed).toStrictEqual(copy);
	});

	it('orders sessions that share a date, a place in the day and a title by their content', () => {
		const squats = lowerA('mon');
		const pulls = strength('mon', 'Lower A', [lift('deadlift', set({ targetRpe: 8 }))]);
		const spar = sparring('tue');
		const result = checkWeek([squats, pulls, spar]);
		expect(result[0]?.message).toBe(
			'Heavy lower body the day before hard Muay Thai: Lower A and Lower A on Monday, then Muay Thai sparring on Tuesday.'
		);
		expect(checkWeek([pulls, squats, spar])).toEqual(result);
	});

	it('documents every rule with its severity and its reason', () => {
		for (const rule of Object.values(INTERFERENCE_RULES)) {
			expect(['avoid', 'prefer']).toContain(rule.severity);
			expect(rule.why).toMatch(/^[A-Z].{40,}\.$/);
		}
	});

	it('blocks no owner edit by default: a broken rule is warned about and recorded', () => {
		expect(BLOCKS_EDIT).toEqual({ avoid: false, prefer: false });
	});
});
