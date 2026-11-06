/**
 * The generator's seven scenario profiles (the M3 brief's scenario tests, the journey profile and
 * the minimal onboarding profile), as complete M2 TrainingProfiles. Every generator slice tests
 * against them, so later slices import them and never edit them: a test that needs a variant
 * builds one from a scenario in its own file. Each call returns a fresh copy.
 *
 * Event dates are fixed weeks after SCENARIO_START, the Monday tests plan week 1 from, so the
 * plans are the same whatever day the suite runs. Ids are stable uuids.
 */
import { addDays } from '../calendar.ts';
import { DISCIPLINES, LIFTS } from '../profile/catalog.ts';
import type {
	BaselineKind,
	Discipline,
	ExperienceLevel,
	GymType,
	Lift
} from '../profile/catalog.ts';
import type * as m2 from '../profile/types.ts';

/** The Monday of week 1 in every scenario test. */
export const SCENARIO_START = '2026-11-09';

const AT = new Date('2026-11-01T08:00:00Z');
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Day `day` (0 Monday … 6 Sunday) of week `week` (from 1) after SCENARIO_START. */
export const scenarioDay = (week: number, day: number) =>
	addDays(SCENARIO_START, 7 * (week - 1) + day);

const goal = (
	priority: number,
	title: string,
	disciplines: Discipline[],
	event?: { type: string; date: string }
): m2.Goal => ({
	id: uuid(100 + priority),
	kind: event ? 'event' : 'general',
	title,
	disciplines,
	customDiscipline: null,
	status: 'active',
	priority,
	eventType: event?.type ?? null,
	eventDate: event?.date ?? null,
	weightClass: null,
	targetPerformance: null,
	requirements: null,
	focus: event ? null : title,
	measure: null,
	targetDate: null,
	notes: null,
	createdAt: AT,
	updatedAt: AT
});

const trained = (discipline: Discipline, level: ExperienceLevel): m2.ExperienceEntry => ({
	id: uuid(300 + DISCIPLINES.indexOf(discipline)),
	discipline,
	customLabel: null,
	level,
	years: null,
	sessionsPerWeek: null,
	notes: null,
	updatedAt: AT
});

const oneRm = (lift: Lift, kg: number, kind: BaselineKind = 'measured'): m2.StrengthBaseline => ({
	id: uuid(400 + LIFTS.indexOf(lift)),
	lift,
	customLabel: null,
	kind,
	source: kind === 'measured' ? 'tested' : 'estimate',
	value: kg,
	unit: 'kg',
	achievedOn: null,
	setWeight: null,
	setReps: null,
	setRpe: null,
	method: null,
	confidence: null,
	notes: null,
	recordedAt: AT
});

const gym = (gymType: GymType | null, homeEquipment: m2.EquipmentProfile['equipment'] = []) => ({
	gymType,
	equipment: [],
	homeEquipment,
	notes: null,
	updatedAt: AT
});

/** Muay Thai classes on Tuesday and Thursday evenings. */
const classes = (over: Partial<m2.Commitment> = {}): m2.Commitment => ({
	id: uuid(200),
	discipline: 'muay_thai',
	label: 'Muay Thai class',
	days: ['tue', 'thu'],
	timeOfDay: 'evening',
	durationMinutes: null,
	intensity: null,
	notes: null,
	...over
});

type Over = Omit<Partial<m2.TrainingProfile>, 'schedule' | 'profile'> & {
	schedule?: Partial<m2.Schedule>;
	baselinesUnknown?: boolean;
};

function profile({ schedule, baselinesUnknown = false, ...over }: Over): m2.TrainingProfile {
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
			baselinesUnknown,
			onboarding: { current: 'review', completed: ['review'], skipped: [], completedAt: AT },
			updatedAt: AT
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
		...over,
		schedule: {
			daysPerWeek: 3,
			availableDays: [],
			preferredTimes: [],
			sessionMinutes: null,
			constraints: null,
			commitments: [],
			updatedAt: AT,
			...schedule
		}
	};
}

const WEEKDAYS_BUT_SUNDAY: m2.Schedule['availableDays'] = [
	'mon',
	'tue',
	'wed',
	'thu',
	'fri',
	'sat'
];

export const SCENARIOS = {
	/** Strength only, new to it, every 1RM blank: 3 days of 60 minutes. */
	beginner: () =>
		profile({
			goals: [goal(1, 'Get strong', ['strength'])],
			experience: [trained('strength', 'new')],
			equipment: gym('commercial'),
			baselinesUnknown: true,
			schedule: {
				availableDays: WEEKDAYS_BUT_SUNDAY,
				preferredTimes: ['evening'],
				sessionMinutes: 60
			}
		}),
	/** A meet in week 16, measured squat, bench and deadlift: 4 days of 90 minutes. */
	powerlifter: () =>
		profile({
			goals: [
				goal(1, 'Meet', ['powerlifting'], { type: 'Powerlifting meet', date: scenarioDay(16, 5) })
			],
			experience: [trained('powerlifting', 'advanced')],
			baselines: [oneRm('back_squat', 180), oneRm('bench_press', 120), oneRm('deadlift', 220)],
			equipment: gym('strength'),
			schedule: {
				daysPerWeek: 4,
				availableDays: ['mon', 'tue', 'thu', 'fri', 'sat'],
				preferredTimes: ['morning'],
				sessionMinutes: 90
			}
		}),
	/** A marathon in week 20 first, then strength, around hard Muay Thai classes Tue/Thu evenings. */
	hybrid: () =>
		profile({
			goals: [
				goal(1, 'Marathon', ['distance_running'], { type: 'Marathon', date: scenarioDay(20, 6) }),
				goal(2, 'Stay strong', ['strength']),
				goal(3, 'Muay Thai', ['muay_thai'])
			],
			experience: [
				trained('distance_running', 'intermediate'),
				trained('strength', 'intermediate'),
				trained('muay_thai', 'intermediate')
			],
			baselines: [oneRm('back_squat', 140), oneRm('bench_press', 100, 'estimated')],
			running: {
				unit: 'km',
				weeklyDistance: 30,
				runsPerWeek: 4,
				longestRun: 18,
				easyPaceSeconds: 330,
				races: [],
				notes: null,
				updatedAt: AT
			},
			equipment: gym('commercial'),
			schedule: {
				daysPerWeek: 5,
				availableDays: WEEKDAYS_BUT_SUNDAY,
				preferredTimes: ['morning', 'evening'],
				sessionMinutes: 75,
				commitments: [classes({ durationMinutes: 90, intensity: 'hard' })]
			}
		}),
	/** Strength with an injured left shoulder that must avoid overhead pressing. */
	injuredShoulder: () =>
		profile({
			goals: [goal(1, 'Get stronger', ['strength'])],
			experience: [trained('strength', 'intermediate')],
			baselines: [oneRm('back_squat', 150), oneRm('deadlift', 180)],
			equipment: gym('commercial'),
			injuries: [
				{
					id: uuid(500),
					bodyArea: 'shoulder',
					side: 'left',
					severity: 'moderate',
					notes: null,
					avoid: ['overhead pressing'],
					active: true,
					since: '2026-09-01',
					updatedAt: AT
				}
			],
			schedule: { daysPerWeek: 4, availableDays: WEEKDAYS_BUT_SUNDAY, sessionMinutes: 60 }
		}),
	/** Strength at home with dumbbells and a bench and nothing else: 3 days of 45 minutes. */
	dumbbellsOnly: () =>
		profile({
			goals: [goal(1, 'Get fit at home', ['strength'])],
			experience: [trained('strength', 'novice')],
			equipment: gym('none', ['dumbbells', 'bench']),
			baselinesUnknown: true,
			schedule: { availableDays: ['mon', 'wed', 'fri', 'sat'], sessionMinutes: 45 }
		}),
	/**
	 * The journey (m3/49): a Muay Thai fight in week 5 first, a marathon in week 20, then keeping
	 * strength, around Muay Thai classes on Tue/Thu evenings, 5 days, every 1RM blank.
	 */
	journey: () =>
		profile({
			goals: [
				goal(1, 'Fight', ['muay_thai'], { type: 'Muay Thai fight', date: scenarioDay(5, 5) }),
				goal(2, 'Marathon', ['distance_running'], { type: 'Marathon', date: scenarioDay(20, 6) }),
				goal(3, 'Keep strength', ['strength'])
			],
			experience: [
				trained('muay_thai', 'intermediate'),
				trained('distance_running', 'novice'),
				trained('strength', 'novice')
			],
			equipment: gym('commercial'),
			baselinesUnknown: true,
			schedule: {
				daysPerWeek: 5,
				availableDays: WEEKDAYS_BUT_SUNDAY,
				preferredTimes: ['morning', 'evening'],
				sessionMinutes: 60,
				commitments: [classes()]
			}
		}),
	/** What a completed onboarding needs and nothing more: one undated goal and daysPerWeek 3. */
	minimal: () => profile({ goals: [goal(1, 'Get stronger', ['strength'])] })
} satisfies Record<string, () => m2.TrainingProfile>;

export type ScenarioKey = keyof typeof SCENARIOS;
