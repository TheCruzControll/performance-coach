/**
 * The generator's input (PRD §2, §5): M2's TrainingProfile normalised into one canonical,
 * key-based value that every generator stage reads, the same however the profile's rows were
 * stored or ordered.
 *
 * - Lists are sorted and deduplicated; loads are kg, distances metres, paces seconds per km.
 * - What the owner has not told the coach yet comes from rules/defaults.ts, and `assumptions`
 *   lists each default applied.
 * - Exercises go by key: a catalogue key, or `custom:<uuid>` for one of the owner's own.
 * - Only what can change the program is kept: no timestamps, row ids, start dates, time zone,
 *   display units or notes. Weeks to an event depend on the start, so weeksToEvent counts them.
 * - `refs` holds the goal and commitment uuids the plan cites (BlockPlan.goalRefs and
 *   SessionPlan.commitmentRef). They are row ids, so the fingerprint leaves them out.
 *
 * Pure: no clock, no randomness, no I/O.
 */
import { daysBetween } from '../calendar.ts';
import type { IsoDate } from '../calendar.ts';
import type { CatalogueExercise } from '../exercises/format.ts';
import { matchExercise } from '../exercises/match.ts';
import * as m2 from '../profile/catalog.ts';
import type * as types from '../profile/types.ts';
import type { BaselineLift, CustomExercise, ExerciseRef } from '../training/types.ts';
import { cleanFloat, convertPace, convertWeight, toMetres } from '../units.ts';
import { canonicalJson, compareText, exerciseContent } from './random.ts';
import { DEFAULTS, GYM_PRESETS, defaultCommitmentMinutes } from './rules/defaults.ts';
import type { DefaultKey } from './rules/defaults.ts';

/** An exercise as the generator names it: a catalogue key, or `custom:<uuid>`. */
export type ExerciseKey = string;

const CUSTOM = 'custom:';

export const toExerciseKey = (ref: ExerciseRef): ExerciseKey =>
	'key' in ref ? ref.key : `${CUSTOM}${ref.customId}`;

export const toExerciseRef = (key: ExerciseKey): ExerciseRef =>
	key.startsWith(CUSTOM) ? { customId: key.slice(CUSTOM.length) } : { key };

/** A time a session can be placed at: any M2 time of day but 'varies'. */
export type DistinctTime = Exclude<m2.TimeOfDay, 'varies'>;

/** An open goal. `priority` is M2's rank: 1 wins when goals compete. */
export type InputGoal = Pick<
	types.Goal,
	| 'kind'
	| 'title'
	| 'disciplines'
	| 'customDiscipline'
	| 'eventType'
	| 'eventDate'
	| 'focus'
	| 'targetDate'
> & { priority: number };

/** A fixed commitment, its duration and intensity told or defaulted; 'varies' time is kept. */
export type InputCommitment = Omit<
	types.Commitment,
	'id' | 'notes' | 'durationMinutes' | 'intensity'
> & { durationMinutes: number; intensity: m2.Intensity };

export type InputInjury = Pick<types.Injury, 'bodyArea' | 'side' | 'severity' | 'avoid'>;

/** A 1RM in kg. An estimate stays an estimate: M2 derives the kind from its source. */
export interface InputBaseline {
	kg: number;
	kind: m2.BaselineKind;
}

export interface InputRunning {
	weeklyMetres: number | null;
	runsPerWeek: number | null;
	longestRunMetres: number | null;
	easyPaceSecondsPerKm: number | null;
	races: { distanceMetres: number; timeSeconds: number; racedOn: IsoDate | null }[];
}

export type InputMuayThai = Omit<types.MuayThaiProfile, 'notes' | 'updatedAt'>;

/** One of the owner's own exercises, under its `custom:<uuid>` key. */
export type InputCustomExercise = CustomExercise & { key: ExerciseKey };

/** A default from rules/defaults.ts that the input applied, to the input field it names. */
export interface Assumption {
	ruleKey: `defaults.${DefaultKey}`;
	/** `sessionMinutes`, `commitments.0.intensity`, `experience.running`… */
	field: string;
	value: number | string;
}

export interface ProgrammingInput {
	/** The active goals, by priority. */
	goals: InputGoal[];
	/** Paused goals, by priority: kept apart, they shape nothing… */
	paused: InputGoal[];
	/** …unless every open goal is paused: then their disciplines are planned at maintenance. */
	maintenance: boolean;
	/** The disciplines those goals train, the top goal's first. */
	disciplines: m2.Discipline[];
	/** The level in each discipline trained, custom ones aside. */
	experience: Partial<Record<m2.Discipline, m2.ExperienceLevel>>;
	daysPerWeek: number;
	availableDays: m2.Weekday[];
	preferredTimes: DistinctTime[];
	sessionMinutes: number;
	commitments: InputCommitment[];
	equipment: m2.Equipment[];
	/** Active injuries only. */
	injuries: InputInjury[];
	likes: ExerciseKey[];
	/** Never prescribed; what is both liked and disliked is disliked. */
	dislikes: ExerciseKey[];
	customExercises: InputCustomExercise[];
	/** Each lift a 1RM can anchor: null when blank, never a guess. */
	baselines: Record<BaselineLift, InputBaseline | null>;
	/** Only when running is trained. */
	running: InputRunning | null;
	/** Only when Muay Thai is trained. */
	muayThai: InputMuayThai | null;
	nutritionPhase: m2.NutritionPhase | null;
	bodyWeightKg: number | null;
	assumptions: Assumption[];
	/** The M2 uuids of `goals`, `paused` and `commitments`, by position. Not canonical. */
	refs: { goals: string[]; paused: string[]; commitments: string[] };
}

/** One of the owner's exercises as the library service lists it. */
export type OwnedExercise = CustomExercise & { id: string };

/** A like or dislike, with the library exercise m3/31 linked it to, if any. */
export interface LinkedPreference {
	exercise: string;
	sentiment: m2.Sentiment;
	linked: ExerciseRef | null;
}

export interface InputSources {
	catalogue: readonly CatalogueExercise[];
	customExercises?: readonly OwnedExercise[];
	/** Without links, the profile's own likes and dislikes are matched by name. */
	preferences?: readonly LinkedPreference[];
}

const BASELINE_LIFTS = m2.LIFTS.filter((lift): lift is BaselineLift => lift !== 'custom');
const DISTINCT_TIMES = m2.TIMES_OF_DAY.filter((t): t is DistinctTime => t !== 'varies');

/** The members of `vocabulary` in `values`, in the vocabulary's order, once each. */
const inOrder = <T extends string>(values: readonly string[], vocabulary: readonly T[]): T[] =>
	vocabulary.filter((term) => values.includes(term));

/** Records in the order of their canonical JSON: an arbitrary order, but always the same one. */
const byContent = (a: unknown, b: unknown) => compareText(canonicalJson(a), canonicalJson(b));

const kg = (value: number, unit: 'kg' | 'lb') => cleanFloat(convertWeight(value, unit, 'kg'));

const toGoal = (goal: types.Goal): InputGoal => ({
	kind: goal.kind,
	title: goal.title.trim(),
	disciplines: inOrder(goal.disciplines, m2.DISCIPLINES),
	customDiscipline: goal.disciplines.includes('custom') ? goal.customDiscipline : null,
	priority: goal.priority ?? 0,
	eventType: goal.eventType,
	eventDate: goal.eventDate,
	focus: goal.focus,
	targetDate: goal.targetDate
});

function toRunning(running: types.RunningProfile | null): InputRunning | null {
	if (!running) return null;
	const { unit, easyPaceSeconds: pace } = running;
	const metres = (value: number | null) =>
		value === null ? null : cleanFloat(toMetres(value, unit));
	const result = {
		weeklyMetres: metres(running.weeklyDistance),
		runsPerWeek: running.runsPerWeek,
		longestRunMetres: metres(running.longestRun),
		easyPaceSecondsPerKm: pace === null ? null : cleanFloat(convertPace(pace, unit, 'km')),
		races: running.races
			.map(({ distanceMetres, timeSeconds, racedOn }) => ({ distanceMetres, timeSeconds, racedOn }))
			.sort(byContent)
	};
	return Object.values(result).some((v) => v !== null && (!Array.isArray(v) || v.length))
		? result
		: null;
}

/** Whole weeks from the program's first Monday to the goal's event; null without an event. */
export function weeksToEvent(goal: InputGoal, startsOn: IsoDate): number | null {
	return goal.eventDate === null ? null : Math.floor(daysBetween(startsOn, goal.eventDate) / 7);
}

/**
 * Normalise `profile` for the generator. Likes and dislikes are matched by name against the
 * catalogue and the owner's own exercises, unless m3/31 linked them. A profile needs daysPerWeek,
 * which completing onboarding requires.
 */
export function buildProgrammingInput(
	profile: types.TrainingProfile,
	sources: InputSources
): ProgrammingInput {
	const { schedule } = profile;
	if (schedule.daysPerWeek === null) {
		throw new RangeError('Programming needs daysPerWeek: complete onboarding first');
	}
	const assumptions: Assumption[] = [];
	const assume = (rule: DefaultKey, field: string, value: number | string) =>
		assumptions.push({ ruleKey: `defaults.${rule}`, field, value });

	// Goals: the open ones by rank; achieved and dropped goals are history.
	const ranked = (status: types.Goal['status']) =>
		profile.goals
			.filter((g) => g.status === status)
			.sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0));
	const active = ranked('active');
	const paused = ranked('paused');
	const maintenance = !active.length && paused.length > 0;
	const shaping = (maintenance ? paused : active).map(toGoal);
	const rank = (d: m2.Discipline) => shaping.findIndex((g) => g.disciplines.includes(d));
	const disciplines = m2.DISCIPLINES.filter((d) => rank(d) >= 0).sort((a, b) => rank(a) - rank(b));
	const trains = (...list: m2.Discipline[]) => disciplines.some((d) => list.includes(d));

	// Schedule, in the defaults table's order.
	const availableDays = inOrder(schedule.availableDays, m2.WEEKDAYS);
	if (!availableDays.length) {
		availableDays.push(...m2.WEEKDAYS);
		assume('available_days', 'availableDays', DEFAULTS.available_days.value);
	}
	const preferredTimes = inOrder(schedule.preferredTimes, DISTINCT_TIMES);
	if (!preferredTimes.length) {
		assume('preferred_times', 'preferredTimes', DEFAULTS.preferred_times.value);
	}
	const sessionMinutes = schedule.sessionMinutes ?? DEFAULTS.session_minutes.value;
	if (schedule.sessionMinutes === null) assume('session_minutes', 'sessionMinutes', sessionMinutes);

	const commitments = schedule.commitments
		.map((told) => ({
			told,
			entry: {
				discipline: told.discipline,
				label: told.label.trim(),
				days: inOrder(told.days, m2.WEEKDAYS),
				timeOfDay: told.timeOfDay,
				durationMinutes: told.durationMinutes ?? defaultCommitmentMinutes(told.discipline),
				intensity: told.intensity ?? DEFAULTS.commitment_intensity.value
			}
		}))
		.sort((a, b) => byContent(a.entry, b.entry) || compareText(a.told.id, b.told.id));
	commitments.forEach(({ told, entry }, i) => {
		if (told.intensity !== null) return;
		assume('commitment_intensity', `commitments.${i}.intensity`, entry.intensity);
	});
	commitments.forEach(({ told, entry }, i) => {
		if (told.durationMinutes !== null) return;
		assume('commitment_minutes', `commitments.${i}.durationMinutes`, entry.durationMinutes);
	});

	// Equipment: the gym type's preset, what is ticked and the home kit.
	const kit = profile.equipment;
	const unset = !kit || (!kit.gymType && !kit.equipment.length && !kit.homeEquipment.length);
	const gym = unset ? DEFAULTS.equipment.value : kit.gymType;
	if (unset) assume('equipment', 'equipment', DEFAULTS.equipment.value);
	const equipment = inOrder(
		[...(gym ? GYM_PRESETS[gym] : []), ...(kit?.equipment ?? []), ...(kit?.homeEquipment ?? [])],
		m2.EQUIPMENT
	);

	// Experience: the highest level told for each discipline trained.
	const experience: ProgrammingInput['experience'] = {};
	for (const discipline of disciplines.filter((d) => d !== 'custom')) {
		const told = profile.experience.filter((e) => e.discipline === discipline).map((e) => e.level);
		const level = [...m2.EXPERIENCE_LEVELS].reverse().find((l) => told.includes(l));
		experience[discipline] = level ?? DEFAULTS.experience.value;
		if (!level) assume('experience', `experience.${discipline}`, DEFAULTS.experience.value);
	}

	// Running and Muay Thai specifics, where those are trained.
	const running = trains(...m2.RUNNING_DISCIPLINES) ? toRunning(profile.running) : null;
	if (trains(...m2.RUNNING_DISCIPLINES) && running?.weeklyMetres == null) {
		assume('running_volume', 'running.weeklyMetres', DEFAULTS.running_volume.value);
	}
	const mt = trains('muay_thai') ? profile.muayThai : null;
	const muayThai =
		mt && (mt.sessionsPerWeek ?? mt.sparringPerWeek ?? mt.fights) !== null
			? {
					sessionsPerWeek: mt.sessionsPerWeek,
					sparringPerWeek: mt.sparringPerWeek,
					fights: mt.fights
				}
			: null;
	const classes = commitments.some(({ entry }) => entry.discipline === 'muay_thai');
	if (trains('muay_thai') && !classes && (mt?.sessionsPerWeek ?? mt?.sparringPerWeek) == null) {
		assume('muay_thai_sessions', 'muayThai', DEFAULTS.muay_thai_sessions.value);
	}
	if (maintenance) assume('all_goals_paused', 'maintenance', DEFAULTS.all_goals_paused.value);

	// Exercises: the owner's own, then likes and dislikes by key.
	const customExercises = (sources.customExercises ?? [])
		.map((e): InputCustomExercise => ({ key: `${CUSTOM}${e.id}`, ...exerciseContent(e) }))
		.sort((a, b) => compareText(a.key, b.key));
	const library = [...sources.catalogue, ...customExercises];
	const known = new Set(library.map((e) => e.key));
	const likes = new Set<ExerciseKey>();
	const dislikes = new Set<ExerciseKey>();
	for (const p of sources.preferences ?? profile.exercises.map((e) => ({ ...e, linked: null }))) {
		const link = p.linked && toExerciseKey(p.linked);
		const key = link && known.has(link) ? link : matchExercise(p.exercise, library);
		if (key) (p.sentiment === 'like' ? likes : dislikes).add(key);
	}

	// Baselines in kg, by lift: M2 keeps one current baseline per lift.
	const baselines = Object.fromEntries(
		BASELINE_LIFTS.map((lift) => [lift, null])
	) as ProgrammingInput['baselines'];
	for (const b of profile.baselines) {
		if (b.lift !== 'custom') baselines[b.lift] = { kg: kg(b.value, b.unit), kind: b.kind };
	}
	// The latest weigh-in, as M2 reads it: the last day, then the last entry.
	const [weighIn] = [...profile.bodyWeight].sort(
		(a, b) => compareText(b.measuredOn, a.measuredOn) || b.id - a.id
	);

	return {
		goals: maintenance ? [] : shaping,
		paused: paused.map(toGoal),
		maintenance,
		disciplines,
		experience,
		daysPerWeek: schedule.daysPerWeek,
		availableDays,
		preferredTimes,
		sessionMinutes,
		commitments: commitments.map(({ entry }) => entry),
		equipment,
		injuries: profile.injuries
			.filter((injury) => injury.active)
			.map(({ bodyArea, side, severity, avoid }) => ({
				bodyArea,
				side,
				severity,
				avoid: [...new Set(avoid.map((text) => text.trim()).filter(Boolean))].sort(compareText)
			}))
			.sort(byContent),
		likes: [...likes].filter((key) => !dislikes.has(key)).sort(compareText),
		dislikes: [...dislikes].sort(compareText),
		customExercises,
		baselines,
		running,
		muayThai,
		nutritionPhase: profile.profile.nutritionPhase,
		bodyWeightKg: weighIn ? kg(weighIn.value, weighIn.unit) : null,
		assumptions,
		refs: {
			goals: maintenance ? [] : active.map((g) => g.id),
			paused: paused.map((g) => g.id),
			commitments: commitments.map(({ told }) => told.id)
		}
	};
}
