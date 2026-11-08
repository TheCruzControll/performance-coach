/**
 * Concurrent-training interference (PRD §2, §5): which sessions may sit next to which, as pure,
 * data-driven checks over a week of sessions. Placement (m3/23) builds each week with them and
 * the owner's move edit (m3/34) warns with them, so a generated plan and an edit are judged, and
 * explained, by the same rules.
 *
 * - demandOf(session) says what a session asks of the body: heavy lower or upper body, hard Muay
 *   Thai, a long run, intervals, very demanding, hard or easy.
 * - checkWeek(sessions) lists the rules the sessions break, each with its days, its sessions and
 *   a sentence naming them. 'avoid' is a rule to keep; 'prefer' is advice.
 * - Every threshold is in INTERFERENCE, and every rule with its reason in INTERFERENCE_RULES:
 *   judgement calls that M7 tunes and extends as data.
 *
 * It reads only the sessions it is given: no clock, profile or goal priority. Placement weighs
 * priorities and decides what to do about a violation; the move edit records it. The result is
 * the same for any input order. Server-only, like all of domain/programming: it reads the
 * exercise catalogue.
 */
import { addDays, mondayOf, weekdayOf } from '../calendar.ts';
import type { IsoDate } from '../calendar.ts';
import { catalogueByKey } from '../exercises/index.ts';
import type { CatalogueExercise } from '../exercises/index.ts';
import { TIMES_OF_DAY, WEEKDAY_INFO } from '../profile/catalog.ts';
import type { Discipline, TimeOfDay } from '../profile/catalog.ts';
import type {
	ExerciseRef,
	OtherDetails,
	OtherSessionPlan,
	RunSegment,
	RunSessionPlan,
	SetPrescription,
	StrengthSessionPlan
} from '../training/types.ts';
import { isHardSet, NON_WORKING_ROLES } from '../training/metrics.ts';
import { MUSCLE_GROUP } from '../training/vocabulary.ts';
import type * as v from '../training/vocabulary.ts';

// ---- What the checks read -------------------------------------------------------------------

/** When a session happens, and what it is. */
type When = 'date' | 'timeOfDay' | 'orderInDay';
type Shared = When | 'type' | 'title' | 'discipline' | 'intensity' | 'estMinutes' | 'source';
type SetLine = Pick<SetPrescription, 'role' | 'sets' | 'targetRpe' | 'loadKind' | 'loadValue'>;

/** What the checks read of a session: a SessionPlan, or a stored session with the same fields. */
export type InterferenceSession =
	| (Pick<StrengthSessionPlan, 'kind' | Shared> & {
			exercises: readonly { exercise: ExerciseRef; sets: readonly SetLine[] }[];
	  })
	| (Pick<RunSessionPlan, 'kind' | Shared> & { segments: readonly Pick<RunSegment, 'kind'>[] })
	| (Pick<OtherSessionPlan, 'kind' | Shared> & { details: Pick<OtherDetails, 'kind'> });

/** What the checks read of an exercise. */
export type ExerciseTraits = Pick<CatalogueExercise, 'pattern' | 'primaryMuscles' | 'tags'>;

/** An exercise's traits; an unknown one counts as neither lower nor upper body. */
export type TraitsOf = (exercise: ExerciseRef) => ExerciseTraits | undefined;

/** The catalogue's traits for a key. The owner's own exercises need the caller's lookup. */
export const catalogueTraits: TraitsOf = (ref) =>
	'key' in ref ? catalogueByKey.get(ref.key) : undefined;

/** What a session asks of the body. */
export interface SessionDemand {
	/** Heavy or high-volume leg work: squats, hinges, lunges, Olympic lifts, jumps. */
	heavyLower: boolean;
	/** Heavy or high-volume pushing and pulling. */
	heavyUpper: boolean;
	/** Hard Muay Thai: a hard session, or sparring at any intensity. */
	hardCombat: boolean;
	longRun: boolean;
	/** Interval running, a hard running club included. */
	intervals: boolean;
	/** Enough on its own to make its day very demanding. */
	veryDemanding: boolean;
	/** Any of the above, or a hard intensity. */
	hard: boolean;
	/** Easy by intensity or type, with nothing hard about it: an easy run, mobility. */
	easy: boolean;
}

/** The demands that come from what a session holds. */
type Load = 'heavyLower' | 'heavyUpper' | 'hardCombat' | 'longRun' | 'intervals';

// ---- The thresholds -------------------------------------------------------------------------

const list = <K extends string>(...keys: K[]): readonly K[] => keys;
const byDiscipline = (table: Readonly<Record<Discipline, readonly (Load | 'veryDemanding')[]>>) =>
	table;

/**
 * Every interference threshold, in one keyed table, so M7 tunes them as data (m3-plan open
 * question on the coaching thresholds). Each is a judgement call, with its reason.
 */
export const INTERFERENCE = {
	/** Intensities that make any session hard, and the one that is very demanding by itself. */
	hardIntensities: list<v.SessionIntensity>('hard', 'very_hard'),
	veryDemandingIntensities: list<v.SessionIntensity>('very_hard'),
	/** A heavy set: RPE 8 leaves about two reps in reserve; 80 % of a 1RM is about an 8RM. */
	heavySetRpe: 8,
	heavySetFraction: 0.8,
	/** Only lifts with these tags can be heavy; lighter work counts by its volume. */
	heavyLiftTags: list<v.ExerciseTag>('compound'),
	/**
	 * Hard sets for one body region in one session that make it high volume, at any load. A hard
	 * set is training/metrics.ts's isHardSet, the one definition.
	 */
	highVolumeHardSets: 10,
	/** Patterns that work the legs, or the upper body. Other patterns go by primary muscles. */
	lowerPatterns: list<v.MovementPattern>('squat', 'hinge', 'lunge', 'olympic', 'plyometric'),
	upperPatterns: list<v.MovementPattern>(
		'horizontal_push',
		'vertical_push',
		'horizontal_pull',
		'vertical_pull'
	),
	lowerGroups: list<v.MuscleGroup>('quads', 'hamstrings', 'hips', 'calves'),
	upperGroups: list<v.MuscleGroup>('chest', 'back', 'shoulders', 'biceps', 'triceps', 'forearms'),
	/** Mobility tires nothing, so it never counts. */
	restfulPatterns: list<v.MovementPattern>('mobility'),
	/** A long run by its type, or any run of 90 minutes or more. */
	longRunTypes: list<v.SessionType>('long_run'),
	longRunMinutes: 90,
	/** Intervals by type, or any run with an interval segment, a fartlek's included. */
	intervalTypes: list<v.SessionType>('interval_run'),
	intervalSegments: list<v.RunSegmentKind>('interval'),
	/** A combat discipline is hard combat when the session is hard; sparring always is. */
	combatDisciplines: list<Discipline>('muay_thai'),
	combatHardFormats: list<v.OtherSessionKind>('sparring'),
	/** What makes a session very demanding by itself, besides a very hard intensity. */
	veryDemandingLoads: list<Load>('longRun', 'hardCombat'),
	/** A day holding this many hard sessions is very demanding, whatever they are. */
	veryDemandingDay: 2,
	/** Session types that are easy unless something above makes them hard. */
	easyTypes: list<v.SessionType>('easy_run', 'recovery_run', 'mobility'),
	/**
	 * A hard commitment, by discipline. A class sets its own content, so a hard strength,
	 * athletic or custom class is very demanding, and a hard running club is intervals.
	 */
	hardCommitment: byDiscipline({
		powerlifting: ['veryDemanding'],
		weightlifting: ['veryDemanding'],
		strength: ['veryDemanding'],
		hypertrophy: ['veryDemanding'],
		running: ['intervals'],
		distance_running: ['intervals'],
		muay_thai: ['hardCombat'],
		athletic: ['veryDemanding'],
		custom: ['veryDemanding']
	})
} as const;

// ---- The rules ------------------------------------------------------------------------------

export type Severity = 'avoid' | 'prefer';

/** A sequence a rule flags: a session with demand `first`, then one with demand `then`. */
interface Sequence {
	first: keyof SessionDemand;
	then: keyof SessionDemand;
	/** The opening words of its message. */
	headline: string;
}

type RuleData = { severity: Severity; why: string } & (
	{ gap: 0 | 1; sequences: readonly Sequence[] } | { headline: string }
);

/**
 * The rules, in the order they are listed within a day.
 * - A sequence rule flags `first`, then `then`: the next day (gap 1), where `first` reads its
 *   whole day, so a day holding two hard sessions is very demanding; or later the same day
 *   (gap 0), in time-of-day order when both sessions have a time, otherwise by order in the day.
 * - hard_days_apart flags two hard days in a row, one of which could move, only when every hard
 *   day that can move could sit apart: commitments, and days outside the open dates, stay where
 *   they are, even side by side.
 */
export const INTERFERENCE_RULES = {
	heavy_lower_before_hard: {
		severity: 'avoid',
		gap: 1,
		sequences: [
			{
				first: 'heavyLower',
				then: 'hardCombat',
				headline: 'Heavy lower body the day before hard Muay Thai'
			},
			{
				first: 'heavyLower',
				then: 'longRun',
				headline: 'Heavy lower body the day before a long run'
			}
		],
		why: 'Heavy squats, hinges or a high-volume leg day tire the legs for a day or more: hard Muay Thai on tired legs risks injury, and a long run on them is slower and harder to recover from.'
	},
	intervals_after_very_demanding: {
		severity: 'avoid',
		gap: 1,
		sequences: [
			{
				first: 'veryDemanding',
				then: 'intervals',
				headline: 'Intervals the day after a very demanding day'
			}
		],
		why: 'Intervals need fresh legs to hold their paces. After a long run, hard Muay Thai, a hard class or a day of two hard sessions they are slower, and the injury risk rises.'
	},
	hard_days_apart: {
		severity: 'prefer',
		headline: 'Hard days back to back, though the week has room to keep them apart',
		why: 'An easier day between hard days lets the body recover, so each hard session is done well. A week with more hard days than it can space out is left as it is.'
	},
	same_day_order: {
		severity: 'prefer',
		gap: 0,
		sequences: [
			{
				first: 'heavyLower',
				then: 'hardCombat',
				headline: 'Heavy lower body before hard Muay Thai on the same day'
			},
			{
				first: 'heavyLower',
				then: 'longRun',
				headline: 'Heavy lower body before a long run on the same day'
			},
			{
				first: 'veryDemanding',
				then: 'intervals',
				headline: 'A very demanding session before intervals on the same day'
			}
		],
		why: 'When one day holds both, the session that needs fresh legs comes first: the Muay Thai, the long run or the intervals, then the lifting or the other hard session.'
	}
} as const satisfies Record<string, RuleData>;

export type InterferenceRule = keyof typeof INTERFERENCE_RULES;

/**
 * Whether a broken rule of each severity blocks an owner's edit instead of warning (m3-plan open
 * question on moves). The plan's default blocks none: a move that breaks a rule goes ahead, and
 * its warning is returned and recorded in the decision's why. Set avoid to true to block.
 */
export const BLOCKS_EDIT: Readonly<Record<Severity, boolean>> = { avoid: false, prefer: false };

export interface Violation<S extends InterferenceSession = InterferenceSession> {
	rule: InterferenceRule;
	severity: Severity;
	/** The dates it spans, earliest first. */
	days: IsoDate[];
	/** The sessions it names, the earlier first: the caller's own objects. */
	sessions: S[];
	/** One sentence naming its days and its sessions. */
	message: string;
}

export interface CheckOptions {
	/** Exercise traits: catalogueTraits by default, which knows none of the owner's own. */
	traitsOf?: TraitsOf;
	/**
	 * The dates a generated session could move to, for hard_days_apart: the owner's available
	 * days, or the dates a move can still reach. By default every date of the sessions' weeks.
	 */
	openDates?: readonly IsoDate[];
}

// ---- demandOf -------------------------------------------------------------------------------

const T = INTERFERENCE;
export type Region = 'lower' | 'upper';

/** The region an exercise works; null for mobility or a mix. load/systems.ts reads it too. */
export function regionOf({ pattern, primaryMuscles }: ExerciseTraits): Region | null {
	if (T.restfulPatterns.includes(pattern)) return null;
	if (T.lowerPatterns.includes(pattern)) return 'lower';
	if (T.upperPatterns.includes(pattern)) return 'upper';
	const groups = primaryMuscles.map((muscle) => MUSCLE_GROUP[muscle]);
	if (groups.length === 0) return null;
	if (groups.every((group) => T.lowerGroups.includes(group))) return 'lower';
	return groups.every((group) => T.upperGroups.includes(group)) ? 'upper' : null;
}

/** RPE 8 or more, or 80 % or more of a 1RM: a ramp's climb to that included. */
export const isHeavySet = (line: SetLine) =>
	(line.targetRpe ?? 0) >= T.heavySetRpe ||
	((line.loadKind === 'percent_1rm' || line.loadKind === 'from_e1rm') &&
		(line.loadValue ?? 0) >= T.heavySetFraction);

/** A prescription line's hard sets, by training/metrics.ts's single hard-set definition. */
export const hardSetsIn = (line: SetLine) =>
	isHardSet(!NON_WORKING_ROLES.includes(line.role), line.targetRpe) ? line.sets : 0;

/**
 * Whether a strength session works `region` heavily: a heavy lift there in a hard session or at
 * a heavy set, or high volume at any load.
 */
function works(session: InterferenceSession, region: Region, hard: boolean, traitsOf: TraitsOf) {
	if (session.kind !== 'strength') return false;
	let hardSets = 0;
	for (const { exercise, sets } of session.exercises) {
		const traits = traitsOf(exercise);
		if (!traits || regionOf(traits) !== region) continue;
		const heavyLift = traits.tags.some((tag) => T.heavyLiftTags.includes(tag));
		if (heavyLift && (hard || sets.some(isHeavySet))) return true;
		hardSets += sets.reduce((sum, line) => sum + hardSetsIn(line), 0);
	}
	return hardSets >= T.highVolumeHardSets;
}

/** What `session` asks of the body. A commitment is also read by its discipline and intensity. */
export function demandOf(
	session: InterferenceSession,
	traitsOf: TraitsOf = catalogueTraits
): SessionDemand {
	const hard = T.hardIntensities.includes(session.intensity);
	const committed: readonly (Load | 'veryDemanding')[] =
		session.source === 'commitment' && hard ? T.hardCommitment[session.discipline] : [];
	const run = session.kind === 'run' ? session : null;
	const loads: Record<Load, boolean> = {
		heavyLower: works(session, 'lower', hard, traitsOf),
		heavyUpper: works(session, 'upper', hard, traitsOf),
		hardCombat:
			committed.includes('hardCombat') ||
			(session.kind === 'other' && T.combatHardFormats.includes(session.details.kind)) ||
			(hard && T.combatDisciplines.includes(session.discipline)),
		longRun:
			T.longRunTypes.includes(session.type) || (run !== null && run.estMinutes >= T.longRunMinutes),
		intervals:
			committed.includes('intervals') ||
			T.intervalTypes.includes(session.type) ||
			(run?.segments.some((segment) => T.intervalSegments.includes(segment.kind)) ?? false)
	};
	const veryDemanding =
		committed.includes('veryDemanding') ||
		T.veryDemandingIntensities.includes(session.intensity) ||
		T.veryDemandingLoads.some((load) => loads[load]);
	const anyHard = hard || veryDemanding || Object.values(loads).includes(true);
	const easy = !anyHard && (session.intensity === 'easy' || T.easyTypes.includes(session.type));
	return { ...loads, veryDemanding, hard: anyHard, easy };
}

// ---- checkWeek ------------------------------------------------------------------------------

interface Row<S> {
	session: S;
	demand: SessionDemand;
	/** Its demand as part of its day: on a day of hard sessions, each hard one is very demanding. */
	inDay: SessionDemand;
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const timeRank = (time: TimeOfDay | null) =>
	time === null || time === 'varies' ? null : TIMES_OF_DAY.indexOf(time);
const dayName = (date: IsoDate) => WEEKDAY_INFO[weekdayOf(date)].label;

/** One fixed order for sessions, whatever order they come in. */
function canonical(a: InterferenceSession, b: InterferenceSession): number {
	return (
		compare(a.date, b.date) ||
		a.orderInDay - b.orderInDay ||
		(timeRank(a.timeOfDay) ?? -1) - (timeRank(b.timeOfDay) ?? -1) ||
		compare(a.title, b.title) ||
		compare(JSON.stringify(a), JSON.stringify(b))
	);
}

/** Whether `a` is done before `b` on their day: by time of day when both have one, else by order. */
function before(a: InterferenceSession, b: InterferenceSession): boolean {
	const [ta, tb] = [timeRank(a.timeOfDay), timeRank(b.timeOfDay)];
	return ta !== null && tb !== null && ta !== tb ? ta < tb : a.orderInDay < b.orderInDay;
}

/** 'Lower A', 'Lower A and Tempo run', 'A, B and C'. */
function titles(rows: readonly { session: InterferenceSession }[]): string {
	const names = rows.map((row) => row.session.title);
	return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join('');
}

function violation<S extends InterferenceSession>(
	rule: InterferenceRule,
	headline: string,
	earlier: readonly Row<S>[],
	later: readonly Row<S>[]
): Violation<S> {
	const [from, to] = [earlier[0]!.session.date, later[0]!.session.date];
	const where =
		from === to
			? `${titles(earlier)}, then ${titles(later)}, on ${dayName(from)}`
			: `${titles(earlier)} on ${dayName(from)}, then ${titles(later)} on ${dayName(to)}`;
	return {
		rule,
		severity: INTERFERENCE_RULES[rule].severity,
		days: from === to ? [from] : [from, to],
		sessions: [...earlier, ...later].map((row) => row.session),
		message: `${headline}: ${where}.`
	};
}

/**
 * Whether `count` hard days fit in `span` with an easier day between each: the fixed ones where
 * they are, even side by side, the others on open days that touch no fixed one.
 */
function roomToSpread(
	span: readonly IsoDate[],
	count: number,
	fixed: ReadonlySet<IsoDate>,
	open: ReadonlySet<IsoDate>
): boolean {
	let room = fixed.size;
	let run = 0;
	for (const date of span) {
		const nearFixed = fixed.has(addDays(date, -1)) || fixed.has(addDays(date, 1));
		if (open.has(date) && !fixed.has(date) && !nearFixed) run += 1;
		else [room, run] = [room + Math.ceil(run / 2), 0];
	}
	return room + Math.ceil(run / 2) >= count;
}

type Days<S> = ReadonlyMap<IsoDate, readonly Row<S>[]>;

/** Each date's sessions in order, with their demands; a day of hard sessions is very demanding. */
function byDay<S extends InterferenceSession>(sorted: readonly S[], traitsOf: TraitsOf): Days<S> {
	const days = new Map<IsoDate, Row<S>[]>();
	for (const session of sorted) {
		const demand = demandOf(session, traitsOf);
		days.set(session.date, [...(days.get(session.date) ?? []), { session, demand, inDay: demand }]);
	}
	for (const rows of days.values()) {
		if (rows.filter((row) => row.demand.hard).length < T.veryDemandingDay) continue;
		for (const row of rows) row.inDay = { ...row.demand, veryDemanding: row.demand.hard };
	}
	return days;
}

/** Every sequence rule's violations: `first` on a day, then `then` that day or the next. */
function sequences<S extends InterferenceSession>(days: Days<S>): Violation<S>[] {
	const found: Violation<S>[] = [];
	for (const [rule, data] of Object.entries(INTERFERENCE_RULES) as [InterferenceRule, RuleData][]) {
		if (!('sequences' in data)) continue;
		for (const [date, rows] of days) {
			for (const { first, then, headline } of data.sequences) {
				for (const later of days.get(addDays(date, data.gap)) ?? []) {
					if (!later.demand[then]) continue;
					const earlier = rows.filter((row) =>
						data.gap === 0
							? row.demand[first] && before(row.session, later.session)
							: row.inDay[first]
					);
					if (earlier.length > 0) found.push(violation(rule, headline, earlier, [later]));
				}
			}
		}
	}
	return found;
}

/** hard_days_apart over `span`, the Monday-to-Sunday weeks the sessions fall in. */
function hardDaysApart<S extends InterferenceSession>(
	days: Days<S>,
	span: readonly IsoDate[],
	openDates: readonly IsoDate[] = span
): Violation<S>[] {
	const open = new Set(openDates);
	const hardOn = (date: IsoDate) => (days.get(date) ?? []).filter((row) => row.demand.hard);
	const hardDays = span.filter((date) => hardOn(date).length > 0);
	const fixed = new Set(
		hardDays.filter(
			(date) => !open.has(date) || hardOn(date).some((row) => row.session.source === 'commitment')
		)
	);
	if (!roomToSpread(span, hardDays.length, fixed, open)) return [];
	const { headline } = INTERFERENCE_RULES.hard_days_apart;
	return hardDays
		.filter((date) => hardOn(addDays(date, 1)).length > 0)
		.filter((date) => !fixed.has(date) || !fixed.has(addDays(date, 1)))
		.map((date) => violation('hard_days_apart', headline, hardOn(date), hardOn(addDays(date, 1))));
}

/**
 * The interference rules `sessions` break, by first day, then in INTERFERENCE_RULES' order.
 * Pass the sessions that will happen, skipped ones left out: a week, or more, in any order.
 */
export function checkWeek<S extends InterferenceSession>(
	sessions: readonly S[],
	options: CheckOptions = {}
): Violation<S>[] {
	if (sessions.length === 0) return [];
	const sorted = [...sessions].sort(canonical);
	const days = byDay(sorted, options.traitsOf ?? catalogueTraits);
	const span: IsoDate[] = [];
	const last = addDays(mondayOf(sorted.at(-1)!.date), 6);
	for (let date = mondayOf(sorted[0]!.date); date <= last; date = addDays(date, 1)) span.push(date);
	const order: string[] = Object.keys(INTERFERENCE_RULES);
	return [...sequences(days), ...hardDaysApart(days, span, options.openDates)].sort(
		(a, b) => compare(a.days[0]!, b.days[0]!) || order.indexOf(a.rule) - order.indexOf(b.rule)
	);
}
