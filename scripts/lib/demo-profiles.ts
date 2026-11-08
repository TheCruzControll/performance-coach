/**
 * Complete M2 training profiles written straight to Postgres, for tooling that needs the real
 * generator to have something to plan: the seeded Lighthouse run (scripts/lighthouse.ts) and its
 * integration test. Plain pg and raw SQL, so plain Node loads it (the drizzle schema's
 * extensionless imports cannot be); only types come from the domain.
 *
 * seedDemoProfile replaces the owner's whole training profile in one transaction on the client
 * it is given, so re-running it gives the same profile. It writes no program.
 */
import type pg from 'pg';
import type {
	Discipline,
	Equipment,
	ExperienceLevel,
	GymType,
	Intensity,
	Lift,
	TimeOfDay,
	Weekday
} from '../../src/lib/domain/profile/catalog.ts';
import type { OnboardingStep } from '../../src/lib/domain/profile/onboarding.ts';

export const DEMO_PROFILES = ['hybrid-blank', 'powerlifter-measured'] as const;
export type DemoProfile = (typeof DEMO_PROFILES)[number];

interface Demo {
	name: string;
	baselinesUnknown: boolean;
	bodyWeightKg: number;
	goals: { title: string; disciplines: Discipline[]; focus: string; measure: string }[];
	experience: { discipline: Discipline; level: ExperienceLevel; years: number }[];
	baselines: { lift: Lift; valueKg: number }[];
	gymType: GymType;
	equipment: Equipment[];
	running: { weeklyKm: number; runsPerWeek: number; longestKm: number; easyPace: number } | null;
	muayThai: { sessionsPerWeek: number; sparringPerWeek: number } | null;
	schedule: { daysPerWeek: number; sessionMinutes: number; preferredTimes: TimeOfDay[] };
	commitments: {
		discipline: Discipline;
		label: string;
		days: Weekday[];
		timeOfDay: TimeOfDay;
		minutes: number;
		intensity: Intensity;
	}[];
}

const COMMERCIAL: Equipment[] = [
	'barbell',
	'squat_rack',
	'bench',
	'dumbbells',
	'kettlebells',
	'cables',
	'machines',
	'pull_up_bar',
	'treadmill',
	'rower'
];

/**
 * - hybrid-blank: strength, running and Muay Thai with no 1RMs ("I don't know my maxes"), five
 *   days with two evening Muay Thai classes: week 1 establishes the baselines.
 * - powerlifter-measured: a powerlifter with tested squat, bench and deadlift maxes, four days.
 */
const DEMOS: Readonly<Record<DemoProfile, Demo>> = {
	'hybrid-blank': {
		name: 'Hybrid demo',
		baselinesUnknown: true,
		bodyWeightKg: 75,
		goals: [
			goal('Stay strong', 'strength'),
			goal('Run a 10k', 'running'),
			goal('Muay Thai', 'muay_thai')
		],
		experience: [
			{ discipline: 'strength', level: 'intermediate', years: 4 },
			{ discipline: 'running', level: 'intermediate', years: 2 },
			{ discipline: 'muay_thai', level: 'intermediate', years: 3 }
		],
		baselines: [],
		gymType: 'commercial',
		equipment: COMMERCIAL,
		running: { weeklyKm: 20, runsPerWeek: 3, longestKm: 10, easyPace: 360 },
		muayThai: { sessionsPerWeek: 2, sparringPerWeek: 1 },
		schedule: { daysPerWeek: 5, sessionMinutes: 60, preferredTimes: ['morning', 'evening'] },
		commitments: [
			{
				discipline: 'muay_thai',
				label: 'Muay Thai class',
				days: ['tue', 'thu'],
				timeOfDay: 'evening',
				minutes: 90,
				intensity: 'hard'
			}
		]
	},
	'powerlifter-measured': {
		name: 'Powerlifter demo',
		baselinesUnknown: false,
		bodyWeightKg: 90,
		goals: [goal('Total more', 'powerlifting')],
		experience: [{ discipline: 'powerlifting', level: 'advanced', years: 6 }],
		baselines: [
			{ lift: 'back_squat', valueKg: 200 },
			{ lift: 'bench_press', valueKg: 140 },
			{ lift: 'deadlift', valueKg: 240 }
		],
		gymType: 'strength',
		equipment: [...COMMERCIAL, 'platform', 'specialty_bars'],
		running: null,
		muayThai: null,
		schedule: { daysPerWeek: 4, sessionMinutes: 90, preferredTimes: ['evening'] },
		commitments: []
	}
};

function goal(title: string, discipline: Discipline): Demo['goals'][number] {
	return { title, disciplines: [discipline], focus: title, measure: 'Train every planned week' };
}

const STEPS: OnboardingStep[] = [
	'welcome',
	'goals',
	'experience',
	'strength',
	'specifics',
	'equipment',
	'injuries',
	'exercises',
	'schedule',
	'body',
	'review'
];

/** The training-profile tables, children first; none references another. */
const PROFILE_TABLES = [
	'body_weight_entries',
	'training_goal_events',
	'training_goals',
	'discipline_experience',
	'strength_baselines',
	'race_results',
	'running_profiles',
	'muay_thai_profiles',
	'equipment_profiles',
	'injuries',
	'exercise_preferences',
	'schedule_commitments',
	'schedules',
	'athlete_profiles'
];

/**
 * Replace `ownerId`'s training profile with the demo `name`, onboarding complete, in one
 * transaction on `client` (one query at a time). Commits: callers clean up after themselves.
 */
export async function seedDemoProfile(
	client: pg.ClientBase,
	ownerId: string,
	name: DemoProfile
): Promise<void> {
	const demo = DEMOS[name];
	const run = (sql: string, params: unknown[] = []) => client.query(sql, [ownerId, ...params]);
	await client.query('begin');
	try {
		for (const table of PROFILE_TABLES) await run(`delete from ${table} where owner_id = $1`);
		await run(
			`insert into athlete_profiles (owner_id, name, baselines_unknown, onboarding_completed,
			   onboarding_completed_at) values ($1, $2, $3, $4, now())`,
			[demo.name, demo.baselinesUnknown, STEPS]
		);
		await run(
			`insert into body_weight_entries (owner_id, value, unit, measured_on, source)
			 values ($1, $2, 'kg', current_date, 'onboarding')`,
			[demo.bodyWeightKg]
		);
		for (const [i, g] of demo.goals.entries()) {
			await run(
				`insert into training_goals (owner_id, kind, title, disciplines, priority, focus, measure)
				 values ($1, 'general', $2, $3, $4, $5, $6)`,
				[g.title, g.disciplines, i + 1, g.focus, g.measure]
			);
		}
		for (const e of demo.experience) {
			await run(
				`insert into discipline_experience (owner_id, discipline, level, years) values ($1, $2, $3, $4)`,
				[e.discipline, e.level, e.years]
			);
		}
		for (const b of demo.baselines) {
			await run(
				`insert into strength_baselines (owner_id, lift, kind, source, value, unit)
				 values ($1, $2, 'measured', 'tested', $3, 'kg')`,
				[b.lift, b.valueKg]
			);
		}
		await run(
			`insert into equipment_profiles (owner_id, gym_type, equipment) values ($1, $2, $3)`,
			[demo.gymType, demo.equipment]
		);
		if (demo.running) {
			const r = demo.running;
			await run(
				`insert into running_profiles (owner_id, unit, weekly_distance, runs_per_week, longest_run,
				   easy_pace_seconds) values ($1, 'km', $2, $3, $4, $5)`,
				[r.weeklyKm, r.runsPerWeek, r.longestKm, r.easyPace]
			);
		}
		if (demo.muayThai) {
			await run(
				`insert into muay_thai_profiles (owner_id, sessions_per_week, sparring_per_week)
				 values ($1, $2, $3)`,
				[demo.muayThai.sessionsPerWeek, demo.muayThai.sparringPerWeek]
			);
		}
		const s = demo.schedule;
		await run(
			`insert into schedules (owner_id, days_per_week, preferred_times, session_minutes)
			 values ($1, $2, $3, $4)`,
			[s.daysPerWeek, s.preferredTimes, s.sessionMinutes]
		);
		for (const c of demo.commitments) {
			await run(
				`insert into schedule_commitments (owner_id, discipline, label, days, time_of_day,
				   duration_minutes, intensity) values ($1, $2, $3, $4, $5, $6, $7)`,
				[c.discipline, c.label, c.days, c.timeOfDay, c.minutes, c.intensity]
			);
		}
		await client.query('commit');
	} catch (error) {
		await client.query('rollback');
		throw error;
	}
}
