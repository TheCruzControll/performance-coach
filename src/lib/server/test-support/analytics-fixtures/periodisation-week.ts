/**
 * The periodisation-week fixture (m7/04 train-week-findings): a hybrid program whose week ahead
 * holds one interference finding the owner made, for Train's findings, its page-data gate and
 * the evaluation service's integration test. Written through the real services (M2's profile,
 * M3's program store and its move edit) at dates counted from the owner's today, so it holds on
 * any weekday.
 *
 * Every planned week is the same clean hybrid week, Monday rest: Muay Thai classes on Tuesday
 * and Thursday evenings (the owner's commitment, hard), Upper A on Wednesday, Lower A (heavy
 * squats) on Friday, an easy run on Saturday and the long run on Sunday. It breaks no rule:
 * nothing heavy for the legs comes the day before hard Muay Thai or the long run, and the hard
 * days cannot sit further apart around the two fixed classes.
 *
 * - Base (four weeks): last week (week 1, past), this week (week 2), the owner-move week (week
 *   3, next week) and a clean week (week 4); then Build, OUTLINE_WEEKS outline weeks (week 5 on).
 * - This week is the past and the rest of the week: on yesterday (none on a Monday) Lower B in the
 *   morning, then Sparring in the evening, a clash whose day has passed; from today on, an easy
 *   run a day, which breaks nothing.
 * - Next week the owner moved Lower A from Friday to Monday (version 2, through M3's moveSession),
 *   the day before Tuesday's hard Muay Thai: one avoid finding, kept because the owner moved it.
 * - The generator's placement decisions (m7/14, PLACEMENT_DECISIONS), each citing its session in
 *   every hybrid week, of the kinds the generator writes: the classes as a commitment
 *   (commitments.ts) and Lower A kept off the day before hard Muay Thai (placement.ts). No stage
 *   writes session_placed, so Upper A and the runs, on the days they prefer, are in none, and
 *   neither are this week's sessions: they have no 'Why this day?'.
 *
 * Bridge weeks and 'First block complete' come from the bridge-week and block-end-late fixtures.
 * TEST ONLY, like the rest of this folder.
 */
import { addDays, daysBetween, type IsoDate } from '../../../domain/calendar';
import { CATALOGUE } from '../../../domain/exercises/index';
import { buildProgrammingInput, catalogueDigest, GENERATOR_ID } from '../../../domain/programming';
import type {
	DecisionPlan,
	ProgramPlan,
	SessionPlan,
	SetPrescription
} from '../../../domain/training/types';
import {
	createGoal,
	getTrainingProfile,
	saveExperience,
	saveSchedule
} from '../../services/profile/index';
import { moveSession } from '../../services/programs/edits';
import { createProgramFromPlan, getProgramVersion } from '../../services/programs/index';
import type { AnalyticsFixture, FixtureResult, SeedContext } from './index';
import { block, week } from './reviews';

/** Outline weeks after Base. */
export const OUTLINE_WEEKS = 2;

/** Each week by its number in the program. */
export const FIXTURE_WEEKS = { past: 1, current: 2, moved: 3, clean: 4, outline: 5 } as const;

export interface PeriodisationWeekResult extends FixtureResult {
	/** The Monday of each fixture week, by name. */
	mondays: Record<keyof typeof FIXTURE_WEEKS, IsoDate>;
}

type Slot = { timeOfDay: 'morning' | 'evening'; orderInDay: number };
const MORNING: Slot = { timeOfDay: 'morning', orderInDay: 1 };

const base = (date: IsoDate, title: string, minutes: number, rpe: number, slot: Slot) => ({
	...{ date, title, ...slot, estMinutes: minutes, targetRpe: rpe, estLoad: minutes * rpe },
	...{ customDiscipline: null, commitmentRef: null, instructions: null, notes: null },
	source: 'generator' as const
});

const rx = (sets: number, reps: number, rpe: number): SetPrescription => ({
	...{ role: 'working', sets, repsMin: reps, repsMax: reps, targetRpe: rpe, loadKind: 'rpe_based' },
	...{ seconds: null, metres: null, loadValue: null, loadUnit: null, loadBasis: null },
	...{ reference1rm: null, reference1rmUnit: null, tempo: null, notes: null, restSeconds: 150 }
});

/** A strength session of `lifts`: [key, sets, reps, RPE]; hard when a set is at RPE 8. */
function strength(
	date: IsoDate,
	title: string,
	lifts: [key: string, sets: number, reps: number, rpe: number][]
): SessionPlan {
	const rpe = Math.max(...lifts.map(([, , , r]) => r));
	return {
		...base(date, title, 60, rpe, MORNING),
		kind: 'strength',
		type: 'strength',
		discipline: 'strength',
		intensity: rpe >= 8 ? 'hard' : 'moderate',
		exercises: lifts.map(([key, sets, reps, r]) => ({
			...{ exercise: { key }, sets: [rx(sets, reps, r)], baselineLift: null, superset: null },
			...{ substitutedFrom: null, substitutionReason: null, instructions: null, notes: null }
		}))
	};
}

const lowerA = (date: IsoDate) =>
	strength(date, 'Lower A', [
		['back_squat', 3, 5, 8],
		['romanian_deadlift', 3, 8, 7]
	]);
const lowerB = (date: IsoDate) => strength(date, 'Lower B', [['back_squat', 4, 4, 8]]);
const upperA = (date: IsoDate) =>
	strength(date, 'Upper A', [
		['bench_press', 3, 6, 7],
		['barbell_row', 3, 8, 7]
	]);

function run(date: IsoDate, type: 'easy_run' | 'long_run', minutes: number): SessionPlan {
	const segment = {
		...{ kind: type === 'long_run' ? ('long' as const) : ('easy' as const), repeatGroup: null },
		...{ repeats: null, distanceMetres: null, durationSeconds: minutes * 60, hrZone: 2 as const },
		...{ targetRpe: null, paceMinSecondsPerKm: null, paceMaxSecondsPerKm: null }
	};
	return {
		...base(date, type === 'long_run' ? 'Long run' : 'Easy run', minutes, 4, MORNING),
		kind: 'run',
		type,
		discipline: 'running',
		intensity: 'easy',
		segments: [segment]
	};
}

/** The owner's class (commitment), or the generator's sparring: hard Muay Thai either way. */
function muayThai(date: IsoDate, kind: 'class' | 'sparring', commitment: string | null) {
	// After Lower B the same day, sparring is the day's second session.
	const evening: Slot = { timeOfDay: 'evening', orderInDay: kind === 'sparring' ? 2 : 1 };
	return {
		...base(date, kind === 'class' ? 'Muay Thai class' : 'Sparring', 90, 8, evening),
		...(commitment ? { source: 'commitment' as const, commitmentRef: commitment } : {}),
		kind: 'other',
		type: 'muay_thai',
		discipline: 'muay_thai',
		intensity: 'hard',
		details: { kind, durationMinutes: 90, targetRpe: 8, metrics: [], notes: null }
	} satisfies SessionPlan;
}

/** The clean hybrid week from `monday`. */
function hybridWeek(monday: IsoDate, commitment: string): SessionPlan[] {
	const day = (d: number) => addDays(monday, d);
	return [
		muayThai(day(1), 'class', commitment),
		upperA(day(2)),
		muayThai(day(3), 'class', commitment),
		lowerA(day(4)),
		run(day(5), 'easy_run', 40),
		run(day(6), 'long_run', 100)
	];
}

/** This week: yesterday's clash (none on a Monday), then an easy run a day from today. */
function currentWeek(ctx: SeedContext): SessionPlan[] {
	const offset = daysBetween(ctx.weekStart, ctx.today);
	const yesterday = addDays(ctx.today, -1);
	const ahead = Array.from({ length: 7 - offset }, (_, i) =>
		run(addDays(ctx.today, i), 'easy_run', 30)
	);
	return offset > 0 ? [lowerB(yesterday), muayThai(yesterday, 'sparring', null), ...ahead] : ahead;
}

/** The hybrid weeks by their place in Base (this week, place 1, is not one). */
const HYBRID_PLACES = [0, 2, 3] as const;

/**
 * The generator's placement decisions on the hybrid weeks, in its own words
 * (decisions/templates) and only of the kinds its stages write: which of hybridWeek's sessions,
 * by place, each one cites.
 */
const PLACEMENT_DECISIONS: (Omit<DecisionPlan, 'refs' | 'evidence'> & { sessions: number[] })[] = [
	{
		kind: 'commitment_placed',
		ruleKey: 'commitments.fixed',
		summary: 'Muay Thai class on Tuesday and Thursday',
		why: 'Muay Thai class is one of your fixed commitments, so it goes in first, every Tuesday and Thursday evening, for 90 min at hard intensity, and the rest of the week is planned around it.',
		decidedBy: 'rules',
		sessions: [0, 2]
	},
	{
		kind: 'interference_resolved',
		ruleKey: 'placement.heavy_lower_before_hard',
		summary: 'Lower A kept clear of Muay Thai class',
		why: 'Heavy lower body the day before hard Muay Thai: Lower A on Wednesday, then Muay Thai class on Thursday, so Lower A goes on Friday morning instead.',
		decidedBy: 'rules',
		sessions: [3]
	}
];

/** A goal across the three disciplines, and the Tuesday and Thursday classes. */
async function profile(ctx: SeedContext) {
	const deps = { db: ctx.db };
	const goal = await createGoal(
		ctx.ownerId,
		{
			kind: 'general',
			title: 'Strong, fit and sharp',
			disciplines: ['strength', 'running', 'muay_thai'],
			focus: 'Lifts and long run up around two classes a week',
			measure: 'Working sets and long-run time'
		},
		deps
	);
	const commitment = {
		...{ discipline: 'muay_thai', label: 'Muay Thai class', days: ['tue', 'thu'] },
		...{ timeOfDay: 'evening', durationMinutes: 90, intensity: 'hard', notes: null }
	};
	const schedule = await saveSchedule(
		ctx.ownerId,
		{
			daysPerWeek: 6,
			availableDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
			preferredTimes: ['morning', 'evening'],
			sessionMinutes: 60,
			commitments: [commitment]
		},
		deps
	);
	// Intermediate in each: four hard days a week are within the hard-day cap (m7/22's context).
	await saveExperience(
		ctx.ownerId,
		{
			entries: ['strength', 'running', 'muay_thai'].map((d) => ({
				discipline: d,
				level: 'intermediate'
			}))
		},
		deps
	);
	return { goal: goal.id, commitment: schedule.commitments[0]!.id };
}

const periodisationWeek: AnalyticsFixture = async (ctx): Promise<PeriodisationWeekResult> => {
	const deps = { db: ctx.db };
	const { goal, commitment } = await profile(ctx);
	const monday = (n: number) => addDays(ctx.weekStart, 7 * (n - FIXTURE_WEEKS.current));
	const mondays = {
		past: monday(FIXTURE_WEEKS.past),
		current: ctx.weekStart,
		moved: monday(FIXTURE_WEEKS.moved),
		clean: monday(FIXTURE_WEEKS.clean),
		outline: monday(FIXTURE_WEEKS.outline)
	};
	const weeks = [
		week(mondays.past, 'accumulation', hybridWeek(mondays.past, commitment)),
		week(mondays.current, 'accumulation', currentWeek(ctx)),
		week(mondays.moved, 'accumulation', hybridWeek(mondays.moved, commitment)),
		week(mondays.clean, 'accumulation', hybridWeek(mondays.clean, commitment))
	];
	const outline = Array.from({ length: OUTLINE_WEEKS }, (_, i) =>
		week(addDays(mondays.outline, 7 * i), 'accumulation', [])
	);
	const plan: ProgramPlan = {
		title: 'Strength, running and Muay Thai',
		startsOn: mondays.past,
		firstPlannedDay: mondays.past,
		blocks: [block('Base', weeks, goal), block('Build', outline, goal, true)],
		decisions: [
			{
				kind: 'program_purpose',
				ruleKey: 'blocks.default',
				summary: 'Strength, running and Muay Thai together',
				why: 'Periodisation fixture: two lifting days, two runs and two classes a week.',
				decidedBy: 'rules',
				refs: ['blocks.0'],
				evidence: {}
			},
			...PLACEMENT_DECISIONS.map(({ sessions, ...decision }) => ({
				...decision,
				refs: HYBRID_PLACES.flatMap((w) =>
					sessions.map((n) => `blocks.0.weeks.${w}.sessions.${n}`)
				),
				evidence: {}
			}))
		]
	};
	const input = buildProgrammingInput(await getTrainingProfile(ctx.ownerId, deps), {
		catalogue: CATALOGUE
	});
	const origin = {
		source: 'rules' as const,
		generator: GENERATOR_ID,
		digest: catalogueDigest(CATALOGUE, []),
		snapshot: input as unknown as Record<string, unknown>
	};
	const { programId } = await createProgramFromPlan(ctx.ownerId, plan, origin, deps);

	const v1 = await getProgramVersion(ctx.ownerId, programId, 1, deps);
	const [, current, moved] = v1.blocks[0]!.weeks;
	const named = (title: string) => moved!.sessions.find((s) => s.title === title)!;
	const lineages: Record<string, string> = {
		moved: named('Lower A').lineage,
		hardMuayThai: moved!.sessions.find((s) => s.date === addDays(mondays.moved, 1))!.lineage
	};
	const passed = current!.sessions.find((s) => s.title === 'Lower B');
	if (passed) lineages.passed = passed.lineage;
	await moveSession(
		ctx.ownerId,
		{ sessionLineage: lineages.moved, toDate: mondays.moved, reason: 'Friday is busy at work' },
		{ version: 1, today: ctx.today },
		{ ...deps, now: () => ctx.now, source: 'owner' }
	);
	return {
		programId,
		historyStart: mondays.past,
		exercises: {},
		workouts: {},
		lineages,
		mondays
	};
};

export const fixtures = { 'periodisation-week': periodisationWeek } satisfies Record<
	string,
	AnalyticsFixture
>;
