/**
 * The Build preview (PRD §5): the program the generator makes from the owner's profile today,
 * with its rationale, before anything is stored. It writes no draft; build.ts regenerates it and
 * compares fingerprints.
 *
 * - Only a profile that finished onboarding is planned (a goal and daysPerWeek at least).
 * - The generator reads the catalogue from code (CATALOGUE), never from the database, plus the
 *   owner's own exercises and the library links of their likes and dislikes. Tests inject a
 *   changed catalogue through deps.
 * - The fingerprint covers the profile, the library's digest and GENERATOR_ID, but not the start
 *   dates or the time zone; the preview returns them beside it so the build keeps them.
 */
import { addDays, weekdayOf, type IsoDate } from '../../../domain/calendar';
import type { Weekday } from '../../../domain/profile/catalog';
import { CATALOGUE, type CatalogueExercise } from '../../../domain/exercises/index';
import {
	buildProgrammingInput,
	catalogueDigest,
	fingerprint,
	generateProgram,
	type ExerciseKey,
	type LinkedPreference,
	type ProgrammingInput
} from '../../../domain/programming/index';
import { toExerciseKey } from '../../../domain/programming/input';
import type {
	BlockPlan,
	DecisionPlan,
	ProgramPlan,
	SessionPlan,
	WeekPlan
} from '../../../domain/training/types';
import type { DecisionKind } from '../../../domain/training/vocabulary';
import type { Executor } from '../../db/types';
import { getExercisesByIds, listCustomExercises } from '../exercises/index';
import { getTrainingProfile } from '../profile';
import { listExercisePreferences } from '../training/preferences';
import { parseWith, resolveDeps, TrainingInputError, type TrainingDeps } from '../training/shared';
import { previewRequestSchema, startDates, type StartDates } from './start';

export interface ProgrammingDeps extends TrainingDeps {
	/** The catalogue the generator reads; CATALOGUE unless a test changes it. */
	catalogue?: readonly CatalogueExercise[];
}

/** What the preview shows under each heading of the rationale. */
export type DecisionGroup =
	'purpose' | 'assumptions' | 'placement' | 'conflicts' | 'exclusions' | 'loads';

/**
 * The heading each decision kind goes under; null for the kinds a generation never makes (the
 * confirmation and the owner's edits). TypeScript makes every new kind pick one.
 */
export const DECISION_GROUP: Readonly<Record<DecisionKind, DecisionGroup | null>> = {
	program_purpose: 'purpose',
	block_structure: 'purpose',
	event_taper: 'purpose',
	split_chosen: 'purpose',
	exercise_selected: 'purpose',
	quality_session: 'purpose',
	default_assumed: 'assumptions',
	commitment_placed: 'placement',
	day_allocation: 'placement',
	session_placed: 'placement',
	interference_resolved: 'placement',
	priority_tradeoff: 'conflicts',
	session_dropped: 'conflicts',
	time_trimmed: 'conflicts',
	goal_excluded: 'exclusions',
	exercise_excluded: 'exclusions',
	exercise_substituted: 'exclusions',
	slot_empty: 'exclusions',
	unmapped_avoidance: 'exclusions',
	load_basis: 'loads',
	progression: 'loads',
	volume_adjusted: 'loads',
	run_volume: 'loads',
	run_pace_source: 'loads',
	owner_confirmed: null,
	session_moved: null,
	session_skipped: null,
	exercise_swapped: null,
	prescription_adjusted: null,
	preference_recorded: null
};

const GROUPS: readonly DecisionGroup[] = [
	'purpose',
	'assumptions',
	'placement',
	'conflicts',
	'exclusions',
	'loads'
];

/** What a field error at `onboarding` says. */
export const ONBOARDING_FIRST = 'Finish setting up your profile first';

/** The program as a whole, for the preview's header and its block timeline. */
export interface PreviewSummary extends Pick<
	ProgramPlan,
	'title' | 'startsOn' | 'firstPlannedDay'
> {
	plannedWeeks: number;
	blocks: (Omit<BlockPlan, 'weeks' | 'progression'> & { plannedWeeks: number })[];
}

export interface PreviewDay {
	date: IsoDate;
	weekday: Weekday;
	sessions: SessionPlan[];
}

/** Week 1, Monday first: a day before firstPlannedDay has no sessions. */
export type PreviewWeek = Omit<WeekPlan, 'sessions'> & { days: PreviewDay[] };

export interface ProgramPreview extends StartDates {
	summary: PreviewSummary;
	week: PreviewWeek;
	/** The name of every exercise week 1 prescribes, by key. */
	exerciseNames: Record<ExerciseKey, string>;
	/** Every decision the generation made, by heading, in the order the generator lists them. */
	decisions: Record<DecisionGroup, DecisionPlan[]>;
	/** Sent back with the build, which refuses it once the profile or the library changed. */
	fingerprint: string;
	digest: string;
}

/** One generation, with what the build stores beside it. */
export interface Generated {
	plan: ProgramPlan;
	input: ProgrammingInput;
	digest: string;
	fingerprint: string;
	/** The name of every exercise in the owner's library, by key. */
	names: ReadonlyMap<ExerciseKey, string>;
}

/** The owner's profile as the generator's input, with the library it was read against. */
async function readInput(ownerId: string, db: Executor, catalogue: readonly CatalogueExercise[]) {
	const profile = await getTrainingProfile(ownerId, { db });
	if (!profile.profile.onboarding.completedAt) {
		throw new TrainingInputError({ onboarding: ONBOARDING_FIRST });
	}
	const customExercises = await listCustomExercises(ownerId, { db });
	const preferences = await listExercisePreferences(ownerId, { db });
	const links = await getExercisesByIds(
		ownerId,
		preferences.flatMap((p) => (p.exerciseId ? [p.exerciseId] : [])),
		{ db }
	);
	const linked = preferences.map((p): LinkedPreference => {
		const row = p.exerciseId ? links.get(p.exerciseId) : undefined;
		return {
			exercise: p.exercise,
			sentiment: p.sentiment,
			linked: !row ? null : row.key !== null ? { key: row.key } : { customId: row.id }
		};
	});
	const input = buildProgrammingInput(profile, { catalogue, customExercises, preferences: linked });
	const names = new Map<ExerciseKey, string>([
		...catalogue.map((e) => [e.key, e.name] as const),
		...customExercises.map((e) => [`custom:${e.id}`, e.name] as const)
	]);
	return { input, digest: catalogueDigest(catalogue, customExercises), names };
}

/** Generate the owner's program for week 1's dates. */
export async function generateFor(
	ownerId: string,
	dates: StartDates,
	deps: ProgrammingDeps
): Promise<Generated> {
	const { db } = resolveDeps(deps);
	const { input, digest, names } = await readInput(ownerId, db, deps.catalogue ?? CATALOGUE);
	const plan = generateProgram(input, dates);
	return { plan, input, digest, fingerprint: fingerprint(input, digest), names };
}

function summaryOf(plan: ProgramPlan): PreviewSummary {
	const blocks = plan.blocks.map(({ weeks, progression: _, ...block }) => ({
		...block,
		plannedWeeks: weeks.length
	}));
	const { title, startsOn, firstPlannedDay } = plan;
	const plannedWeeks = blocks.reduce((n, b) => n + b.plannedWeeks, 0);
	return { title, startsOn, firstPlannedDay, plannedWeeks, blocks };
}

function weekOf({ sessions, ...week }: WeekPlan): PreviewWeek {
	const days = Array.from({ length: 7 }, (_, n) => {
		const date = addDays(week.startsOn, n);
		return { date, weekday: weekdayOf(date), sessions: sessions.filter((s) => s.date === date) };
	});
	return { ...week, days };
}

function groupDecisions(decisions: readonly DecisionPlan[]): Record<DecisionGroup, DecisionPlan[]> {
	const grouped = Object.fromEntries(GROUPS.map((g) => [g, [] as DecisionPlan[]]));
	for (const decision of decisions) {
		const group = DECISION_GROUP[decision.kind];
		if (group) grouped[group]!.push(decision);
	}
	return grouped as Record<DecisionGroup, DecisionPlan[]>;
}

/** The name of each exercise week 1 prescribes, the ones it replaced included. */
function exerciseNamesIn(week: WeekPlan, names: ReadonlyMap<ExerciseKey, string>) {
	const shown: Record<ExerciseKey, string> = {};
	for (const session of week.sessions) {
		if (session.kind !== 'strength') continue;
		for (const e of session.exercises) {
			for (const ref of e.substitutedFrom ? [e.exercise, e.substitutedFrom] : [e.exercise]) {
				const key = toExerciseKey(ref);
				shown[key] = names.get(key) ?? key;
			}
		}
	}
	return shown;
}

/**
 * Preview the program a build would store: `request` is the owner's local today and when to
 * start ('next_monday' or 'this_week'). Refused with a TrainingInputError at `onboarding` until
 * onboarding is complete.
 */
export async function previewProgram(
	ownerId: string,
	request: unknown,
	deps: ProgrammingDeps = {}
): Promise<ProgramPreview> {
	const { today, start } = parseWith(previewRequestSchema, request);
	const dates = startDates(today, start);
	const { plan, digest, fingerprint, names } = await generateFor(ownerId, dates, deps);
	const week = plan.blocks[0]!.weeks[0]!;
	return {
		...dates,
		summary: summaryOf(plan),
		week: weekOf(week),
		exerciseNames: exerciseNamesIn(week, names),
		decisions: groupDecisions(plan.decisions),
		fingerprint,
		digest
	};
}
