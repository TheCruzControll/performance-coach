/**
 * M7's scenario profiles (periodisation-scenarios): complete M2 TrainingProfiles for every PRD §2
 * and §5 example (S1–S12, coverage.ts), the longest season (the plan budget), an off-season (the
 * maintenance block), every goal paused (M3's all-goals-paused case) and the Playwright journey's
 * exact profile. Every engine, generator, re-plan, coach and journey test imports them and never
 * edits them: a test that needs a variant builds it from a fixture in its own file. Each call
 * returns a fresh copy.
 *
 * Dates are fixed weeks after M3's SCENARIO_START (m7Day), so the plans are the same whatever day
 * the suite runs. Ids are stable uuids, apart from M3's (their fourth group is 8007).
 */
import type { IsoDate } from '../../calendar.ts';
import { DISCIPLINES, LIFTS } from '../../profile/catalog.ts';
import type { Discipline, ExperienceLevel, Lift } from '../../profile/catalog.ts';
import type * as m2 from '../../profile/types.ts';
import { SCENARIOS, scenarioDay } from '../scenarios.ts';
import type { CoverageId } from './coverage.ts';

/**
 * Day `day` (0 Monday … 6 Sunday) of week `week` after M3's SCENARIO_START: week 1 is the week a
 * scenario plan starts, week 0 the week before it, where the logged histories end.
 */
export const m7Day = (week: number, day: number): IsoDate => scenarioDay(week, day);

/**
 * The weeks the longest season covers, from week 1: its keep-strength goal's target date is the
 * Sunday of the last one, after the week-44 marathon and its recovery.
 */
export const LONG_SEASON_WEEKS = 52;

const AT = new Date('2026-11-01T08:00:00Z');
const uuid = (n: number) => `00000000-0000-4000-8007-${String(n).padStart(12, '0')}`;

/** A general goal's measure unless told otherwise. */
const HOLD_OR_RISE = 'Top sets at RPE 8 hold or rise';

type GoalOptions = {
	event?: { type: string; date: IsoDate };
	measure?: string;
	targetDate?: IsoDate;
};

const goal = (priority: number, title: string, disciplines: Discipline[], o: GoalOptions = {}) =>
	({
		id: uuid(100 + priority),
		kind: o.event ? 'event' : 'general',
		title,
		disciplines,
		customDiscipline: null,
		status: 'active',
		priority,
		eventType: o.event?.type ?? null,
		eventDate: o.event?.date ?? null,
		weightClass: null,
		targetPerformance: null,
		requirements: null,
		focus: o.event ? null : title,
		measure: o.event ? null : (o.measure ?? HOLD_OR_RISE),
		targetDate: o.targetDate ?? null,
		notes: null,
		createdAt: AT,
		updatedAt: AT
	}) satisfies m2.Goal;

const fight = (priority: number, week: number) =>
	goal(priority, 'Muay Thai fight', ['muay_thai'], {
		event: { type: 'Muay Thai fight', date: m7Day(week, 5) }
	});
const marathon = (priority: number, week: number) =>
	goal(priority, 'Marathon', ['distance_running'], {
		event: { type: 'Marathon', date: m7Day(week, 6) }
	});
const meet = (priority: number, week: number) =>
	goal(priority, 'Powerlifting meet', ['powerlifting'], {
		event: { type: 'Powerlifting meet', date: m7Day(week, 5) }
	});
const buildMuscle = (priority: number) =>
	goal(priority, 'Build muscle', ['hypertrophy'], { measure: 'Sets per muscle group rise' });
const keepStrength = (priority: number, targetDate?: IsoDate) =>
	goal(priority, 'Keep strength', ['strength'], targetDate ? { targetDate } : {});

const trained = (discipline: Discipline, level: ExperienceLevel = 'intermediate') =>
	({
		id: uuid(300 + DISCIPLINES.indexOf(discipline)),
		discipline,
		customLabel: null,
		level,
		years: null,
		sessionsPerWeek: null,
		notes: null,
		updatedAt: AT
	}) satisfies m2.ExperienceEntry;

/** A tested 1RM in kg. */
const oneRm = (lift: Lift, kg: number) =>
	({
		id: uuid(400 + LIFTS.indexOf(lift)),
		lift,
		customLabel: null,
		kind: 'measured',
		source: 'tested',
		value: kg,
		unit: 'kg',
		achievedOn: m7Day(-4, 5),
		setWeight: null,
		setReps: null,
		setRpe: null,
		method: null,
		confidence: null,
		notes: null,
		recordedAt: AT
	}) satisfies m2.StrengthBaseline;

/** A running profile in km, with a 10K raced six weeks before week 1 when `tenK` is given. */
const running = (weeklyKm: number, longestKm: number, runsPerWeek: number, tenK?: number) =>
	({
		unit: 'km',
		weeklyDistance: weeklyKm,
		runsPerWeek,
		longestRun: longestKm,
		easyPaceSeconds: 330,
		races:
			tenK === undefined
				? []
				: [
						{
							id: uuid(600),
							distance: '10k',
							customDistance: null,
							distanceMetres: 10_000,
							timeSeconds: tenK,
							racedOn: m7Day(-5, 6),
							eventName: null
						}
					],
		notes: null,
		updatedAt: AT
	}) satisfies m2.RunningProfile;

const commercialGym = () =>
	({
		gymType: 'commercial',
		equipment: [],
		homeEquipment: [],
		notes: null,
		updatedAt: AT
	}) satisfies m2.EquipmentProfile;

/** Hard Muay Thai classes on Tuesday and Thursday evenings, 90 minutes each. */
const hardClasses = (): m2.Commitment => ({
	id: uuid(200),
	discipline: 'muay_thai',
	label: 'Muay Thai class',
	days: ['tue', 'thu'],
	timeOfDay: 'evening',
	durationMinutes: 90,
	intensity: 'hard',
	notes: null
});

const EVERY_DAY: m2.Schedule['availableDays'] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const WEEKDAYS_BUT_SUNDAY: m2.Schedule['availableDays'] = [
	'mon',
	'tue',
	'wed',
	'thu',
	'fri',
	'sat'
];

type Over = Omit<Partial<m2.TrainingProfile>, 'schedule' | 'profile'> & {
	schedule: Partial<m2.Schedule> & Pick<m2.Schedule, 'daysPerWeek' | 'sessionMinutes'>;
	baselinesUnknown?: boolean;
};

/**
 * M3's minimal completed onboarding (UTC, kg and km), with a commercial gym and `over`. Deep-cloned,
 * since the day lists and Dates above are shared.
 */
function profile({ schedule, baselinesUnknown = false, ...over }: Over): m2.TrainingProfile {
	const base = SCENARIOS.minimal();
	return structuredClone({
		...base,
		profile: { ...base.profile, baselinesUnknown },
		equipment: commercialGym(),
		...over,
		schedule: {
			...base.schedule,
			availableDays: WEEKDAYS_BUT_SUNDAY,
			preferredTimes: ['morning'],
			...schedule
		}
	});
}

/** Keep strength and keep running fitness, with no event, around Muay Thai classes Tue and Thu. */
const offSeason = () =>
	profile({
		goals: [
			keepStrength(1),
			goal(2, 'Keep running fitness', ['running'], { measure: 'Easy pace holds' })
		],
		experience: [trained('strength'), trained('running'), trained('muay_thai')],
		baselines: [oneRm('back_squat', 140), oneRm('bench_press', 100), oneRm('deadlift', 170)],
		running: running(25, 12, 3),
		schedule: {
			daysPerWeek: 4,
			sessionMinutes: 60,
			preferredTimes: ['morning', 'evening'],
			commitments: [hardClasses()]
		}
	});

export const M7_SCENARIOS = {
	/**
	 * S1 (PRD §2): a Muay Thai fight in week 10 first, a marathon in week 24, then build muscle and
	 * keep strength, around hard Muay Thai classes Tue and Thu evenings, 6 days of 75 minutes.
	 * Its weeks hold heavy squats, leg volume, long runs and intervals beside hard Muay Thai, so S2
	 * to S4 plan from it too.
	 */
	multiGoal: () =>
		profile({
			goals: [fight(1, 10), marathon(2, 24), buildMuscle(3), keepStrength(4)],
			experience: [
				trained('muay_thai'),
				trained('distance_running'),
				trained('hypertrophy'),
				trained('strength')
			],
			baselines: [oneRm('back_squat', 150), oneRm('bench_press', 105)],
			running: running(35, 18, 4, 45 * 60),
			schedule: {
				daysPerWeek: 6,
				availableDays: EVERY_DAY,
				preferredTimes: ['morning', 'evening'],
				sessionMinutes: 75,
				commitments: [hardClasses()]
			}
		}),
	/**
	 * S8: M3's hybrid with strength ranked first and the marathon second. M3 left its general goals'
	 * measure blank, which M2's goal form requires, so they get one.
	 */
	hybridSwap: () => {
		const hybrid = SCENARIOS.hybrid();
		const rank = (g: m2.Goal) =>
			g.disciplines.includes('strength') ? 1 : g.disciplines.includes('distance_running') ? 2 : 3;
		const goals = hybrid.goals.map((g) => ({
			...g,
			priority: rank(g),
			measure: g.kind === 'general' ? (g.measure ?? HOLD_OR_RISE) : g.measure
		}));
		return structuredClone({ ...hybrid, goals });
	},
	/** S5: a marathon in week 3, plus keep strength: the taper starts at once. */
	marathonTaper: () =>
		profile({
			goals: [marathon(1, 3), keepStrength(2)],
			experience: [trained('distance_running'), trained('strength')],
			baselines: [oneRm('back_squat', 130), oneRm('bench_press', 95), oneRm('deadlift', 160)],
			running: running(60, 32, 5, 42 * 60),
			schedule: { daysPerWeek: 5, sessionMinutes: 75 }
		}),
	/** S6: build muscle on 4 days of 75 minutes, intermediate. */
	hypertrophyBlock: () =>
		profile({
			goals: [buildMuscle(1)],
			experience: [trained('hypertrophy')],
			baselines: [oneRm('back_squat', 140), oneRm('bench_press', 100)],
			schedule: {
				daysPerWeek: 4,
				availableDays: ['mon', 'tue', 'thu', 'fri', 'sat'],
				sessionMinutes: 75
			}
		}),
	/** S12: a powerlifting meet in week 10 first, with build muscle second. */
	meetPrep: () =>
		profile({
			goals: [meet(1, 10), buildMuscle(2)],
			experience: [trained('powerlifting'), trained('hypertrophy')],
			baselines: [oneRm('back_squat', 180), oneRm('bench_press', 120), oneRm('deadlift', 220)],
			schedule: {
				daysPerWeek: 4,
				availableDays: ['mon', 'tue', 'thu', 'fri', 'sat'],
				sessionMinutes: 90
			}
		}),
	/** S9 and S11: a marathon in week 16 at 55 km a week, plus strength, 6 days of 75 minutes. */
	runnerLifter: () =>
		profile({
			goals: [marathon(1, 16), goal(2, 'Get stronger', ['strength'])],
			experience: [trained('distance_running'), trained('strength')],
			baselines: [oneRm('back_squat', 140), oneRm('deadlift', 180)],
			running: running(55, 26, 5, 43 * 60),
			schedule: { daysPerWeek: 6, sessionMinutes: 75, preferredTimes: ['morning', 'evening'] }
		}),
	/**
	 * The plan budget: a fight in week 8 first, a marathon in week 44 second, a powerlifting meet in
	 * week 22 third, then build muscle and keep strength, whose target date ends the season's
	 * LONG_SEASON_WEEKS.
	 */
	longSeason: () =>
		profile({
			goals: [
				fight(1, 8),
				marathon(2, 44),
				meet(3, 22),
				buildMuscle(4),
				keepStrength(5, m7Day(LONG_SEASON_WEEKS, 6))
			],
			experience: [
				trained('muay_thai'),
				trained('distance_running'),
				trained('powerlifting'),
				trained('hypertrophy'),
				trained('strength')
			],
			baselines: [oneRm('back_squat', 160), oneRm('bench_press', 110), oneRm('deadlift', 200)],
			running: running(35, 18, 4, 45 * 60),
			schedule: {
				daysPerWeek: 6,
				availableDays: EVERY_DAY,
				preferredTimes: ['morning', 'evening'],
				sessionMinutes: 75,
				commitments: [hardClasses()]
			}
		}),
	/** The maintenance block: keep strength and running fitness, no event, Muay Thai Tue and Thu. */
	offSeason,
	/** M3's all-goals-paused case: offSeason's goals, every one paused. */
	allPaused: () => {
		const off = offSeason();
		return { ...off, goals: off.goals.map((g) => ({ ...g, status: 'paused' as const })) };
	},
	/**
	 * The Playwright journey's exact profile: a marathon about 20 weeks out first, keep strength
	 * second, Muay Thai third with hard classes Tue and Thu evenings, 5 days of 75 minutes, every
	 * 1RM blank.
	 */
	journeyHybrid: () =>
		profile({
			goals: [
				marathon(1, 20),
				keepStrength(2),
				goal(3, 'Muay Thai', ['muay_thai'], { measure: 'Classes feel sharp' })
			],
			experience: [trained('distance_running'), trained('strength'), trained('muay_thai')],
			baselinesUnknown: true,
			running: running(30, 16, 4),
			schedule: {
				daysPerWeek: 5,
				preferredTimes: ['morning', 'evening'],
				sessionMinutes: 75,
				commitments: [hardClasses()]
			}
		})
} satisfies Record<string, () => m2.TrainingProfile>;

export type M7ScenarioKey = keyof typeof M7_SCENARIOS;

/** What each profile covers (coverage.ts). */
export const SCENARIO_COVERAGE = {
	multiGoal: ['S1', 'S2', 'S3', 'S4'],
	hybridSwap: ['S8'],
	marathonTaper: ['S5'],
	hypertrophyBlock: ['S6'],
	meetPrep: ['S12'],
	runnerLifter: ['S9', 'S11'],
	longSeason: ['budget'],
	offSeason: ['maintenance'],
	allPaused: ['paused'],
	journeyHybrid: ['journey']
} as const satisfies Record<M7ScenarioKey, readonly CoverageId[]>;
