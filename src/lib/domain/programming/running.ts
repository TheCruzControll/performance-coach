/**
 * The running week (PRD §5), by the numbers in rules/running.ts:
 * - The runs a week are allocateWeek's (demand.ts), running commitments already counted.
 * - Week 1 is the current weekly volume. With none told it is time-based: easy runs of 30 min
 *   and, unless the runner is new, a 45-minute long run. A running commitment counts in the
 *   week by its duration, at the easy pace in a distance week, and so does a quality session.
 * - Each later week is week 1 × its runVolumeFactor (rules/blocks.ts, so the deload drops it),
 *   and holds never more than 10 % over the most a week before it held. A cutback week holds at
 *   most ENDURANCE.cutback's 80 % of that most (generator-running).
 * - The long run is at most 30 % of the week (its phase's longRunShareMax) and 10 % over the
 *   longest run so far. It may outrun the session length, with a decision; every other run keeps
 *   to it.
 * - One quality session a week only for an intermediate or advanced runner or one with a race
 *   ahead, never in week 1 for a new runner. A new runner with no race gets easy runs only.
 * - Paces come from paces.ts currentPaces on week 1's Monday: the best recent race's VDOT (an
 *   undated race at low confidence when no race has a date), else the told easy pace's, as
 *   ranges at each segment kind's training pace, with a decision saying which; with neither,
 *   segments carry RPE and HR zone alone.
 * - A marathon or half week planned with its running targets (periodisation/endurance.ts) has
 *   its long run at the planned length, within the caps above and at most ENDURANCE.long_run's
 *   1.5 km over the longest planned before it, and its phase's race work up to its hooks' quality
 *   sessions: marathon pace as steady segments closing the long run, threshold runs and 10K-pace
 *   intervals (generator-running).
 * - A running goal that trains alongside the leader or is held at maintenance (prepare's
 *   input.modes) holds its dose: MAINTENANCE_BLOCK's share of the recent volume every week, at
 *   most one quality session, and the long run at its share of the full week, never longer than
 *   the recent longest, so the easy runs give way.
 * - Every planned block, and a marathon's or half's outline phases, carry the progression hooks
 *   (hooksFor) that later periodisation adapts.
 * - Runs go on days naively, one a day and off running-commitment days where another is free,
 *   until placement (m3/23) places every session.
 *
 * Pure: no clock, no randomness, no I/O.
 */
import { addDays, weekdayOf } from '../calendar.ts';
import type { IsoDate } from '../calendar.ts';
import {
	EXPERIENCE_LEVELS,
	RACE_DISTANCE_INFO,
	RACE_DISTANCES,
	RUNNING_DISCIPLINES
} from '../profile/catalog.ts';
import type { ExperienceLevel, Weekday } from '../profile/catalog.ts';
import { sessionLoadOf } from '../training/metrics.ts';
import type { BlockPlan, RunSegment, SessionPlan, WeekPlan } from '../training/types.ts';
import { SESSION_TYPE_LABEL } from '../training/vocabulary.ts';
import type { Phase, WeekKind } from '../training/vocabulary.ts';
import { cleanFloat, formatDuration } from '../units.ts';
import { inWords, nextOrder, sessionPath } from './commitments.ts';
import type { DecisionLog } from './decisions.ts';
import { clip, commitmentQuota, generatedFor } from './demand.ts';
import type { WeekDemand } from './demand.ts';
import { weeksToEvent } from './input.ts';
import type { InputGoal, InputRunning, ProgrammingInput } from './input.ts';
import { currentPaces, paceFor } from './paces.ts';
import type { TrainingPaces } from './paces.ts';
import { segmentOf } from './periodisation/endurance.ts';
import { LIGHT_WEEK_KINDS } from './periodisation/kinds.ts';
import { ENDURANCE, hooksFor } from './rules/endurance.ts';
import type { RaceWork } from './rules/endurance.ts';
import { DOSES, MAINTENANCE_BLOCK } from './rules/maintenance.ts';
import { RECENCY } from './rules/paces.ts';
import * as R from './rules/running.ts';
import type { GenerateOptions } from './stage.ts';

type RunType = keyof typeof R.RUNS;
type QualityType = Exclude<RunType, 'easy_run' | 'long_run'>;
/** A run in a week: a quality session carries its own workout. */
type Slot = { type: RunType; quality: Quality | null };
/** A run's size: metres or minutes (the week's unit) for an easy or long run, minutes for quality. */
type SizedRun = Slot & { size: number };

/** The contract's most sessions a day (orderInDay 1 to 4). */
const ORDER_MAX = 4;
const steady = (type: RunType) => type === 'easy_run' || type === 'long_run';
const easySlot = (): Slot => ({ type: 'easy_run', quality: null });
const km = (metres: number) => `${cleanFloat(metres / 1000, 1)} km`;
const perKm = (seconds: number) => `${formatDuration(seconds)} /km`;

// ---- Days, until placement ------------------------------------------------------------------

/** The dates of `week` a generated session may go on: its training days from `from`. */
export function openDates(week: WeekPlan, days: readonly Weekday[], from: IsoDate): IsoDate[] {
	return Array.from({ length: 7 }, (_, i) => addDays(week.startsOn, i)).filter(
		(date) => date >= from && days.includes(weekdayOf(date))
	);
}

/**
 * Up to `count` dates for generated sessions until placement (m3/23) places every session: one
 * session a date, never one already holding the contract's four, the dates `avoid` rules out last,
 * then those with the fewest sessions so far, the earliest on a tie. In date order; fewer only
 * when the open dates run out, which only a partial week 1 can reach.
 */
export function naiveDates(
	sessions: readonly SessionPlan[],
	open: readonly IsoDate[],
	count: number,
	avoid: (on: readonly SessionPlan[]) => boolean = () => false
): IsoDate[] {
	return open
		.filter((date) => nextOrder(sessions, date) <= ORDER_MAX)
		.map((date) => ({ date, on: sessions.filter((s) => s.date === date) }))
		.sort(
			(a, b) =>
				Number(avoid(a.on)) - Number(avoid(b.on)) ||
				a.on.length - b.on.length ||
				(a.date < b.date ? -1 : 1)
		)
		.slice(0, count)
		.map(({ date }) => date)
		.sort();
}

// ---- Paces ----------------------------------------------------------------------------------

/** The training paces, null for runs set by effort alone, and the decision explaining them. */
interface Paces {
	paces: TrainingPaces | null;
	source: string;
	reason: string;
	ruleKey: 'paces.vdot' | 'running.paces_from_told' | 'running.paces_from_effort';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayMonth = (date: IsoDate) =>
	`${Number(date.slice(8))} ${MONTHS[Number(date.slice(5, 7)) - 1]}`;

const raceName = (metres: number) => {
	const known = RACE_DISTANCES.find(
		(d) => d !== 'other' && RACE_DISTANCE_INFO[d].metres === metres
	);
	const label = known ? RACE_DISTANCE_INFO[known].label : `${km(metres)} race`;
	return label.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase());
};

/** How a low-confidence race is worded after its VDOT (paces.ts RECENCY). */
export const ROUGH_GUIDE = {
	undated: ', a race with no date, so treated as a rough guide',
	old: `, a race over ${RECENCY.fullDays / 7} weeks old, so treated as a rough guide`
} as const;

/** The paces on `on`, by paces.ts currentPaces: a race's VDOT, the told easy pace's, or effort. */
function pacesOf(running: InputRunning | null, on: IsoDate): Paces {
	const found = running ? currentPaces(running, on) : null;
	if (found?.source === 'race') {
		const { race, dated } = found.performance;
		const vdot = Math.round(found.vdot);
		const raced =
			`your ${raceName(race.distanceMetres)} in ${formatDuration(race.timeSeconds)}` +
			(race.racedOn ? ` on ${dayMonth(race.racedOn)}` : '');
		const rough = !dated ? ROUGH_GUIDE.undated : found.confidence === 'low' ? ROUGH_GUIDE.old : '';
		return {
			paces: found.paces,
			source: `your race time, a VDOT of ${vdot}`,
			reason: clip(
				`Paces come from ${raced}, a VDOT of ${vdot}, by Daniels’ formula${rough}. Each is a range.`,
				200
			),
			ruleKey: 'paces.vdot'
		};
	}
	if (found?.source === 'easy_pace') {
		const told = perKm(running!.easyPaceSecondsPerKm!);
		return {
			paces: found.paces,
			source: 'your easy pace',
			reason: `Paces come from your easy pace of ${told}, a VDOT of ${Math.round(found.vdot)} by Daniels’ formula, so they match what you run now; each is a range.`,
			ruleKey: 'running.paces_from_told'
		};
	}
	return {
		paces: null,
		source: 'effort',
		reason: running?.races.length
			? `None of your races is recent enough to set paces and you haven’t told the coach an easy pace, so runs are set by effort alone.`
			: 'You haven’t told the coach an easy pace or a race time, so runs are set by effort alone.',
		ruleKey: 'running.paces_from_effort'
	};
}

function segment(
	kind: keyof typeof R.EFFORTS,
	paces: TrainingPaces | null,
	size: { metres?: number; minutes?: number },
	repeats: number | null = null
): RunSegment {
	const { rpe, hrZone, of10k } = R.EFFORTS[kind];
	// The kind's training pace (rules/paces.ts SEGMENT_PACES); a jog EFFORTS gives no pace has none.
	const pace = paces === null || of10k === null ? null : paceFor(kind, paces);
	return {
		kind,
		repeatGroup: repeats === null ? null : 1,
		repeats,
		distanceMetres: size.metres ?? null,
		durationSeconds: size.minutes === undefined ? null : size.minutes * 60,
		paceMinSecondsPerKm: pace?.[0] ?? null,
		paceMaxSecondsPerKm: pace?.[1] ?? null,
		hrZone,
		targetRpe: rpe
	};
}

// ---- The block's running --------------------------------------------------------------------

interface Quality {
	type: QualityType;
	segments: RunSegment[];
	minutes: number;
	words: string;
	/** The race work it is, with its label as the session's instructions; null for M3's own. */
	work: RaceWork | null;
	instructions: string | null;
}

interface Plan {
	input: ProgrammingInput;
	mode: 'distance' | 'time';
	level: ExperienceLevel;
	race: InputGoal | null;
	/** Generated runs a week, and running commitment sessions a full week. */
	runs: number;
	committedRuns: number;
	/** The running commitments' worth in the week's unit. */
	committed: number;
	/** The week's unit in one minute of easy running: metres, or 1 in a time-based week. */
	perMinute: number;
	/** The running goal trains alongside the leader or is held at maintenance: its dose. */
	dosed: boolean;
	quality: Quality | null;
}

/**
 * The quality session, if the block warrants one: M3's tempo for a half or full marathon and
 * intervals otherwise, or race work's threshold run or 10K-pace intervals (ENDURANCE.quality).
 */
function qualityOf(
	input: ProgrammingInput,
	paces: TrainingPaces | null,
	work: Exclude<RaceWork, 'marathon_pace'> | null = null
): Quality {
	const { warmUpMinutes: warm, coolDownMinutes: cool, tempo, intervals } = R.QUALITY;
	const main = input.sessionMinutes - warm - cool;
	const ends = (middle: RunSegment[]) => [
		segment('warm_up', paces, { minutes: warm }),
		...middle,
		segment('cool_down', paces, { minutes: cool })
	];
	if (work === 'threshold' || (work === null && input.disciplines.includes('distance_running'))) {
		const minutes = Math.min(tempo.minutes, main);
		const at = work ? ENDURANCE.quality.threshold.label : 'at tempo';
		return {
			type: tempo.type,
			segments: ends([segment('tempo', paces, { minutes })]),
			minutes: warm + minutes + cool,
			words: `${warm} min easy, ${minutes} min ${at}, ${cool} min easy`,
			work,
			instructions: work ? `${minutes} min ${at}, between easy running.` : null
		};
	}
	const { workMinutes: hard, recoveryMinutes: jog } = intervals;
	const reps = Math.min(intervals.reps, Math.floor(main / (hard + jog)));
	const repeat = segment('interval', paces, { minutes: hard }, reps);
	if (work === 'intervals') {
		// 10K pace sits between threshold's fast end and VO2max's slow end (periodisation/endurance.ts).
		const tenK = segmentOf('intervals', null, paces).segment;
		repeat.paceMinSecondsPerKm = tenK.paceMinSecondsPerKm;
		repeat.paceMaxSecondsPerKm = tenK.paceMaxSecondsPerKm;
	}
	const at = work ? ENDURANCE.quality.intervals.label : 'hard';
	return {
		type: intervals.type,
		segments: ends([repeat, segment('recovery', null, { minutes: jog }, reps)]),
		minutes: warm + reps * (hard + jog) + cool,
		words: `${warm} min easy, ${reps} × ${hard} min ${at} with ${jog}-minute jogs, ${cool} min easy`,
		work,
		instructions: work ? `${reps} × ${hard} min ${at}, with ${jog}-minute jogs.` : null
	};
}

/** Why the block has no quality session, or null when it warrants one. */
function noQuality(plan: Omit<Plan, 'quality'>): string | null {
	const { input, level, race } = plan;
	const total = plan.runs + plan.committedRuns;
	const hard = input.commitments.find(
		(c) => commitmentQuota(c) === 'runs' && c.intensity === 'hard'
	);
	const mains = input.sessionMinutes - R.QUALITY.warmUpMinutes - R.QUALITY.coolDownMinutes;
	if (input.maintenance) {
		return 'Every goal is paused, so running stays easy and keeps your fitness rather than building it.';
	}
	if (!race && !R.QUALITY.levels.includes(level)) {
		return level === 'new'
			? 'You’re new to running, so every run is easy: that builds the habit, the tendons and the base speed work needs.'
			: 'Quality sessions are for intermediate and advanced runners or a race ahead, so your runs stay easy.';
	}
	if (hard) {
		return `${clip(hard.label, 60)} is a hard run already, so it is the week’s quality session.`;
	}
	if (total < R.QUALITY.minRuns) {
		return `With ${total} runs a week every run stays easy: a quality session needs ${R.QUALITY.minRuns}.`;
	}
	if (mains < R.QUALITY.minMainMinutes) {
		return `Your ${input.sessionMinutes}-minute sessions are too short for a warm-up, quality work and a cool-down.`;
	}
	return null;
}

/**
 * The runs of the `k`th planned week, of kind `kind`, by priority: long, quality, then easy.
 * `qualities` are the week's own quality sessions when its block sets them (weekQualities), else M3's
 * one in the weeks QUALITY names.
 */
function composition(
	plan: Plan,
	kind: WeekKind,
	k: number,
	qualities?: readonly Quality[]
): Slot[] {
	const { level, race, runs, quality } = plan;
	const long = runs >= 2 && !(level === 'new' && (k === 0 || !race));
	const wanted = qualities ?? (quality !== null && R.QUALITY.weeks.includes(kind) ? [quality] : []);
	const held = k === 0 && (level === 'new' || plan.mode === 'time');
	const kept = held ? [] : wanted.slice(0, Math.max(0, runs - Number(long)));
	const easy = runs - Number(long) - kept.length;
	return [
		...(long ? [{ type: 'long_run' as const, quality: null }] : []),
		...kept.map((q) => ({ type: q.type, quality: q })),
		...Array.from({ length: easy }, easySlot)
	];
}

/** The long run's caps: its share of the week, the block's planned length and its step. */
interface LongRun {
	shareMax: number;
	/** The volume its share is of: the week's, or a dosed goal's full week, so the long run holds. */
	shareOf: number;
	/** The block's planned length (WeekTargets.running), or null. */
	target: number | null;
	/** The longest it may be given the runs before it: M3's 10 %, a race plan's or a dose's step. */
	step: number;
}

/**
 * Each run's size, given the week's volume (commitments included), the most it may hold and the
 * long run's caps.
 */
function sizeWeek(
	plan: Plan,
	runs: Slot[],
	volume: number,
	most: number,
	caps: LongRun
): SizedRun[] {
	const { mode, perMinute, committed, input } = plan;
	const least = mode === 'distance' ? R.MIN_RUN.metres : R.MIN_RUN.minutes;
	const sessionCap = input.sessionMinutes * perMinute;
	const longMax = R.LONG_RUN_EXCEEDS_SESSION ? Infinity : sessionCap;
	const { step } = caps;
	const long = runs.some((r) => r.type === 'long_run');
	const quality = runs.reduce((sum, r) => sum + (r.quality?.minutes ?? 0), 0);
	const easyRuns = runs.filter((r) => r.type === 'easy_run').length;
	const left = Math.max(0, Math.min(volume, most) - committed - quality * perMinute);
	// A week too small for its quality sessions and a run beside them runs easy instead, and one
	// too small for each run to reach MIN_RUN has fewer, all easy, so it holds its volume.
	if (quality && left < least) {
		const easy = runs.map((r) => (steady(r.type) ? r : easySlot()));
		return sizeWeek(plan, easy, volume, most, caps);
	}
	const fits = Math.max(1, Math.floor(left / least));
	if (fits < runs.filter((r) => steady(r.type)).length) {
		const easy = Array.from({ length: fits }, easySlot);
		return sizeWeek(plan, [...runs.filter((r) => !steady(r.type)), ...easy], volume, most, caps);
	}
	const floor = (x: number) =>
		mode === 'distance' ? Math.floor(x / R.RUN_DISTANCE_STEP) * R.RUN_DISTANCE_STEP : Math.floor(x);
	const fit = (x: number, cap: number) => floor(Math.min(cap, Math.max(least, x)));

	let longSize = 0;
	let easySize: number;
	if (mode === 'time') {
		// A time-based week keeps week 1's proportions, scaled to the week's volume.
		const { easyMinutes, longMinutes } = R.TIME_BASED_WEEK;
		const scale = left / (easyRuns * easyMinutes + (long ? longMinutes : 0) || 1);
		if (long) longSize = fit(longMinutes * scale, Math.min(longMax, step));
		easySize = fit(easyMinutes * scale, Math.min(sessionCap, longSize || step));
	} else if (long) {
		const share = caps.shareMax * caps.shareOf;
		const wanted = Math.min(caps.target ?? Infinity, share, left - easyRuns * least);
		longSize = fit(wanted, Math.min(longMax, step));
		easySize = fit(easyRuns ? (left - longSize) / easyRuns : 0, Math.min(sessionCap, longSize));
	} else {
		easySize = fit(left / easyRuns, Math.min(sessionCap, step));
	}
	return runs.map((run): SizedRun => ({
		...run,
		size:
			run.type === 'long_run' ? longSize : run.type === 'easy_run' ? easySize : run.quality!.minutes
	}));
}

/** The runs in the order of their dates: easy runs around midweek quality sessions, long last. */
function byDay(runs: SizedRun[]): SizedRun[] {
	const easy = runs.filter((r) => r.type === 'easy_run');
	const quality = runs.filter((r) => !steady(r.type));
	return [
		...easy.slice(0, Math.ceil(easy.length / 2)),
		...quality,
		...easy.slice(Math.ceil(easy.length / 2)),
		...runs.filter((r) => r.type === 'long_run')
	];
}

// ---- Race work ------------------------------------------------------------------------------

type Role = keyof (typeof ENDURANCE.race_work)['marathon'];

/** Weeks that hold no race work: the deload, the race week and recovery. */
const NO_RACE_WORK: readonly WeekKind[] = ['deload', 'event', 'recovery'];

/** A marathon or half phase's event and role, or null for any other phase. */
function enduranceOf(phase: Phase): { event: 'marathon' | 'half'; role: Role } | null {
	const [event, role] = phase.split('_') as [string, Role];
	return (event === 'marathon' || event === 'half') && role in ENDURANCE.race_work.marathon
		? { event, role }
		: null;
}

/** The race work of a `phase` week of kind `kind` (ENDURANCE.race_work), the main workout first. */
function raceWorkOf(phase: Phase, kind: WeekKind): readonly RaceWork[] {
	const endurance = enduranceOf(phase);
	if (!endurance || NO_RACE_WORK.includes(kind)) return [];
	return ENDURANCE.race_work[endurance.event][endurance.role];
}

/**
 * The share of the long run at marathon pace in week `w` of `block` (ENDURANCE.marathon_pace):
 * climbing over the block's build weeks that hold it, at the top in peak, the first in the taper.
 */
function marathonPaceShare(block: BlockPlan, w: number): number {
	const [low, high] = ENDURANCE.marathon_pace.share;
	const role = enduranceOf(block.phase)?.role;
	if (role !== 'build') return role === 'peak' ? high : low;
	const holding = block.weeks.flatMap((week, i) =>
		raceWorkOf(block.phase, week.kind).includes('marathon_pace') ? [i] : []
	);
	return low + ((high - low) * Math.max(0, holding.indexOf(w))) / Math.max(1, holding.length - 1);
}

const RACE_WORDS: Readonly<Record<RaceWork, string>> = {
	marathon_pace: 'marathon pace in the long run',
	threshold: 'a threshold run',
	intervals: '10K-pace intervals'
};

/** Metres rounded down to whole RUN_DISTANCE_STEPs. */
const down = (metres: number) => Math.floor(metres / R.RUN_DISTANCE_STEP) * R.RUN_DISTANCE_STEP;

/** The planned weeks' runs, from week 1's volume to the deload, with the decisions explaining them. */
export function planRuns(
	blocks: readonly BlockPlan[],
	demand: WeekDemand,
	input: ProgrammingInput,
	{ startsOn, firstPlannedDay }: GenerateOptions,
	log: DecisionLog
): BlockPlan[] {
	const share = demand.allocation.streams.find((s) => s.stream === 'runs');
	if (!share) return [...blocks];
	const hooks = (block: BlockPlan) => ({ ...block.progression, ...hooksFor(block.phase) });
	const runs = generatedFor(demand.allocation, 'runs');
	if (!runs) return blocks.map((block) => ({ ...block, progression: hooks(block) }));

	const levels = [input.experience.running, input.experience.distance_running];
	const running = input.running;
	const paces = pacesOf(running, startsOn);
	const easy = paces.paces && paceFor('easy', paces.paces);
	const easyPace =
		running?.easyPaceSecondsPerKm ?? (easy ? (easy[0] + easy[1]) / 2 : R.ASSUMED_EASY_PACE);
	const mode = (running?.weeklyMetres ?? 0) > 0 ? 'distance' : 'time';
	const perMinute = mode === 'time' ? 1 : 60_000 / easyPace;
	const clubs = input.commitments.filter((c) => commitmentQuota(c) === 'runs');
	const clubMinutes = clubs.reduce((sum, c) => sum + c.days.length * c.durationMinutes, 0);
	const goalRef = input.refs.goals[input.goals.indexOf(share.goal)];
	const goalMode = input.maintenance || goalRef === undefined ? undefined : input.modes?.[goalRef];
	const base: Omit<Plan, 'quality'> = {
		input,
		mode,
		level: [...EXPERIENCE_LEVELS].reverse().find((l) => levels.includes(l)) ?? 'new',
		race:
			(input.maintenance ? [] : input.goals).find(
				(g) =>
					g.disciplines.some((d) => RUNNING_DISCIPLINES.includes(d)) &&
					(weeksToEvent(g, startsOn) ?? -1) >= 0
			) ?? null,
		runs,
		committedRuns: clubs.reduce((n, c) => n + c.days.length, 0),
		committed: clubMinutes * perMinute,
		perMinute,
		dosed: goalMode === 'secondary' || goalMode === 'maintenance'
	};
	const why = noQuality(base);
	const plan: Plan = { ...base, quality: why ? null : qualityOf(input, paces.paces) };
	const raceQuality = plan.quality && {
		threshold: qualityOf(input, paces.paces, 'threshold'),
		intervals: qualityOf(input, paces.paces, 'intervals')
	};
	/**
	 * A raced week's quality sessions: its race work's own sessions, then M3's, up to its phase's
	 * qualityPerWeek, marathon pace in the long run counted as one. None in a deload or race week.
	 */
	const weekQualities = (works: readonly RaceWork[], kind: WeekKind, perWeek = 1): Quality[] => {
		if (!raceQuality || NO_RACE_WORK.includes(kind)) return [];
		const own = works.flatMap((work) => (work === 'marathon_pace' ? [] : [raceQuality[work]]));
		const room = perWeek - Number(works.includes('marathon_pace'));
		return [...own, plan.quality!].slice(0, Math.max(0, room));
	};
	const discipline = input.disciplines.includes('distance_running')
		? 'distance_running'
		: 'running';
	const minutesOf = (run: SizedRun) =>
		!steady(run.type) || mode === 'time'
			? run.size
			: Math.max(5, Math.round((run.size / 1000) * (easyPace / 60)));

	const firstRuns = composition(plan, 'baseline', 0);
	const { easyMinutes, longMinutes } = R.TIME_BASED_WEEK;
	const week1 =
		mode === 'distance'
			? running!.weeklyMetres!
			: plan.committed +
				firstRuns.reduce((n, r) => n + (r.type === 'long_run' ? longMinutes : easyMinutes), 0);
	const progression = {
		[mode === 'distance' ? 'runWeek1Metres' : 'runWeek1Minutes']: week1,
		runWeeklyIncreaseMax: R.RUN_WEEKLY_INCREASE_MAX,
		longRunShareMax: R.LONG_RUN_SHARE_MAX,
		longRunStepMax: R.LONG_RUN_STEP_MAX
	};
	/**
	 * A dosed week against week 1: a light week's own factor, else the full week. Its volume is
	 * MAINTENANCE_BLOCK's share of that, which a maintenance week's own factor already is, and its
	 * long run keeps its share of the full week, so the long run holds and the easy runs give way.
	 */
	const lightFactor = ({ kind, targets }: WeekPlan) =>
		(LIGHT_WEEK_KINDS as readonly WeekKind[]).includes(kind) ? targets.runVolumeFactor : 1;
	const dosedFactor = (week: WeekPlan) =>
		week.kind === 'maintenance'
			? week.targets.runVolumeFactor
			: MAINTENANCE_BLOCK.runVolumeFactor * lightFactor(week);

	let k = 0;
	// The most a week has held, which the 10 % rule reads.
	let most = 0;
	let longest = mode === 'distance' ? (running?.longestRunMetres ?? null) : null;
	// The longest long run planned so far, which a race plan's long run rises at most a step over.
	let longestPlanned: number | null = null;
	let planned = 0;
	let week1Runs = 0;
	let longShare: number = R.LONG_RUN_SHARE_MAX;
	let dropped = 0;
	let raceWeeks = 0;
	const quality: string[] = [];
	const over: string[] = [];
	const raceWork = new Set<RaceWork>();
	const result = blocks.map((block, b) => {
		if (block.outline) return { ...block, progression: hooks(block) };
		const phaseHooks = hooksFor(block.phase);
		const weeks = block.weeks.map((week, w) => {
			const targets = week.targets.running;
			// A marathon or half week planned with its targets, for the goal that leads.
			const raced = mode === 'distance' && !plan.dosed && targets !== undefined;
			const works = raced && raceQuality ? raceWorkOf(block.phase, week.kind) : [];
			const qualities = raced
				? weekQualities(works, week.kind, phaseHooks?.qualityPerWeek)
				: undefined;
			const volume = plan.dosed
				? week1 * dosedFactor(week)
				: k === 0
					? week1
					: week1 * week.targets.runVolumeFactor;
			// The 10 % rule caps what the week holds; the long run's share reads its volume, since
			// three runs hold at most 90 % of what it reads and would hold every week to week 1's.
			// A cutback holds at most its share of the biggest week so far.
			const cutback = week.kind === 'cutback' || targets?.cutback === true;
			const limit =
				k === 0
					? volume
					: Math.min(
							most * (1 + R.RUN_WEEKLY_INCREASE_MAX),
							cutback ? most * ENDURANCE.cutback.factor : Infinity
						);
			const m3Step = longest === null ? Infinity : longest * (1 + R.LONG_RUN_STEP_MAX);
			const caps: LongRun = {
				shareMax: phaseHooks?.longRunShareMax ?? R.LONG_RUN_SHARE_MAX,
				shareOf: plan.dosed ? week1 * lightFactor(week) : volume,
				target: raced ? targets.longRunMetres : null,
				step: plan.dosed
					? (longest ?? Infinity)
					: raced && longestPlanned !== null
						? Math.min(m3Step, longestPlanned + ENDURANCE.long_run.stepMetres)
						: m3Step
			};
			// A race week has no long run (endurance.ts plans it none): the race is the week's long effort.
			const slots = composition(plan, week.kind, k, qualities).filter(
				(r) => !(raced && week.kind === 'event' && r.type === 'long_run')
			);
			const sized = sizeWeek(plan, slots, volume, limit, caps);
			const holds = sized.reduce(
				(sum, r) => sum + (steady(r.type) ? r.size : r.size * perMinute),
				plan.committed
			);
			most = Math.max(most, holds);
			longest = Math.max(longest ?? 0, ...sized.filter((r) => steady(r.type)).map((r) => r.size));
			const longRun = sized.find((r) => r.type === 'long_run')?.size;
			if (longRun !== undefined) longestPlanned = Math.max(longestPlanned ?? 0, longRun);
			const sessions = [...week.sessions];
			const open = openDates(week, demand.budget.days, firstPlannedDay);
			const isRun = (on: readonly SessionPlan[]) => on.some((s) => s.kind === 'run');
			const dates = naiveDates(sessions, open, sized.length, isRun);
			// A partial week 1 keeps the long run and the quality session first.
			const kept = byDay(sized.slice(0, dates.length));
			if (k === 0) {
				// A partial week 1 also loses the running commitments before its first day.
				const clubRuns = week.sessions.filter((s) => s.kind === 'run').length;
				dropped = sized.length - kept.length + plan.committedRuns - clubRuns;
				planned = holds;
				week1Runs = sized.length;
				longShare = caps.shareMax;
			}
			if (raced) raceWeeks += 1;
			const cap = week.targets.rpeCap;
			const placed = new Set<RaceWork>();
			kept.forEach((run, d) => {
				const date = dates[d]!;
				const minutes = minutesOf(run);
				const size = mode === 'distance' ? { metres: run.size } : { minutes: run.size };
				// Marathon pace closes the long run: steady segments at M pace, labelled.
				const atPace =
					run.type === 'long_run' && works.includes('marathon_pace')
						? down(run.size * marathonPaceShare(block, w))
						: 0;
				const segments = run.quality
					? run.quality.segments
					: atPace
						? [
								segment('long', paces.paces, { metres: run.size - atPace }),
								segmentOf('marathon_pace', atPace, paces.paces).segment
							]
						: [segment(run.type === 'long_run' ? 'long' : 'easy', paces.paces, size)];
				const path = sessionPath(b, w, sessions.length);
				if (run.type === 'long_run' && minutes > input.sessionMinutes) over.push(path);
				if (run.quality || atPace) quality.push(path);
				if (atPace) placed.add('marathon_pace');
				if (run.quality?.work) placed.add(run.quality.work);
				const targetRpe = Math.min(R.RUNS[run.type].sessionRpe, cap);
				sessions.push({
					kind: 'run',
					date,
					timeOfDay: null,
					orderInDay: nextOrder(sessions, date),
					type: run.type,
					title: SESSION_TYPE_LABEL[run.type],
					discipline,
					customDiscipline: null,
					intensity: R.RUNS[run.type].intensity,
					estMinutes: minutes,
					estLoad: sessionLoadOf({ estMinutes: minutes, targetRpe }),
					targetRpe,
					source: 'generator',
					commitmentRef: null,
					instructions: atPace
						? `The last ${km(atPace)} ${ENDURANCE.marathon_pace.label}.`
						: (run.quality?.instructions ?? null),
					notes: null,
					segments: segments.map((s) => ({ ...s, targetRpe: Math.min(s.targetRpe!, cap) }))
				});
			});
			// The race work in its phase's order, the main workout first.
			for (const work of works) if (placed.has(work)) raceWork.add(work);
			k += 1;
			return { ...week, sessions };
		});
		// The phase's own hooks last: they are what its weeks were sized with.
		return {
			...block,
			progression: { ...block.progression, ...progression, ...phaseHooks },
			weeks
		};
	});

	recordRuns(
		plan,
		{
			why,
			from: firstPlannedDay,
			paces,
			week1,
			planned,
			week1Runs,
			longShare,
			dropped,
			quality,
			over,
			raceWeeks,
			raceWork: [...raceWork]
		},
		share.goal,
		log
	);
	return result;
}

interface Outcome {
	why: string | null;
	/** The first planned day. */
	from: IsoDate;
	paces: Paces;
	week1: number;
	planned: number;
	/** Week 1's generated runs, fewer than the week's runs when it is too small for them. */
	week1Runs: number;
	/** The long run's share of week 1, its phase's (hooksFor) or M3's. */
	longShare: number;
	dropped: number;
	quality: string[];
	over: string[];
	/** Weeks planned to their marathon or half targets, and the race work they hold. */
	raceWeeks: number;
	raceWork: RaceWork[];
}

/** Why each later week's running is what it is, when its block or the goal's dose decides. */
function justification(plan: Plan, o: Outcome, goal: InputGoal): string {
	if (plan.dosed) {
		const dose = Math.round(MAINTENANCE_BLOCK.runVolumeFactor * 100);
		return ` ${clip(goal.title, 50)} doesn’t lead now, so running holds its dose: ${dose} % of your recent volume, ${DOSES.runs.qualityRunsMax} quality run at most and the long run no longer than your recent longest.`;
	}
	if (!o.raceWeeks) return '';
	const { every, factor } = ENDURANCE.cutback;
	return ` Each week follows your race plan: its long run grows at most ${km(ENDURANCE.long_run.stepMetres)} a week, and every ${every}th week of base and build is a cutback at ${factor * 100} % of the biggest week.`;
}

function recordRuns(plan: Plan, o: Outcome, goal: InputGoal, log: DecisionLog) {
	const { input, mode, level, race } = plan;
	const minutes = input.sessionMinutes;
	const clubMinutes = plan.committed / plan.perMinute;
	const club = clubMinutes
		? `, your running commitments counted by their ${Math.round(clubMinutes)} min${mode === 'distance' ? ' at your easy pace' : ''}`
		: '';
	const long = composition(plan, 'baseline', 0).some((r) => r.type === 'long_run');
	const { easyMinutes, longMinutes } = R.TIME_BASED_WEEK;
	const timed =
		`easy runs of ${easyMinutes} min at RPE ${R.EFFORTS.easy.rpe}` +
		(long ? ` and a ${longMinutes}-minute long run` : '');
	const none =
		input.running?.weeklyMetres === 0
			? 'you don’t run at the moment'
			: 'you haven’t said how much you run';
	const volumeKey = plan.dosed
		? 'generator.run_dose'
		: o.raceWeeks
			? 'generator.block_runs'
			: (`running.${mode}_week` as const);
	log.add('run_volume', volumeKey, ['blocks.0.weeks.0'], {
		volume: `${mode === 'distance' ? km(o.planned) : `${Math.round(o.planned)} min`} over ${o.week1Runs + plan.committedRuns} runs`,
		basis: clip(
			mode === 'distance'
				? `the ${km(o.week1)} a week you run now${club}`
				: `time and effort, since ${none}: ${timed}${club}`,
			200
		),
		step: `${R.RUN_WEEKLY_INCREASE_MAX * 100} %`,
		justification: clip(justification(plan, o, goal), 200),
		notes: clip(
			(mode === 'distance' && !plan.dosed && o.planned < R.UNDER_VOLUME * o.week1
				? ` The long run is held to ${Math.round(o.longShare * 100)} % of the week and no other run outgrows it or your ${minutes}-minute sessions, so week 1 holds ${km(o.planned)}.`
				: '') +
				(o.week1Runs < plan.runs
					? ` A run under ${mode === 'distance' ? km(R.MIN_RUN.metres) : `${R.MIN_RUN.minutes} min`} isn’t worth planning, so week 1 has ${o.week1Runs} of your ${plan.runs} runs, and a small week fewer.`
					: '') +
				(o.dropped
					? ` Week 1 starts on ${o.from}, so ${o.dropped} of its runs ${o.dropped === 1 ? 'has' : 'have'} no day left.`
					: ''),
			200
		),
		mode,
		week1: o.week1
	});
	const { source, reason, ruleKey } = o.paces;
	log.add('run_pace_source', ruleKey, [], { source, reason });
	const q = plan.quality;
	const name = q?.type === 'tempo_run' ? 'tempo run' : 'interval session';
	const warrant = race
		? `${clip(race.title, 50)} on ${race.eventDate} is ahead`
		: `You run at ${level} level`;
	const later =
		level === 'new' || mode === 'time' ? ' It starts after week 1, which sets your baseline.' : '';
	if (o.raceWork.length) {
		const choice = inWords(o.raceWork.map((work) => RACE_WORDS[work]));
		log.add('quality_session', 'endurance.race_work', o.quality, {
			choice: clip(choice, 200),
			reason: clip(
				`${warrant}, so each week trains race pace: ${choice}. Deload and race weeks leave it out.`,
				200
			)
		});
	} else {
		log.add(
			'quality_session',
			q && o.quality.length ? `running.${q.type}` : 'running.easy_only',
			o.quality,
			{
				choice: q && o.quality.length ? `one ${name} a week` : 'easy running only',
				reason: clip(
					!q
						? o.why!
						: o.quality.length
							? `${warrant}, so one ${name} a week builds your speed: ${q.words}. Lighter weeks leave it out.${later}`
							: 'No week of this block has room for a quality session, so every run stays easy.',
					200
				)
			}
		);
	}
	if (o.over.length) {
		log.add('priority_tradeoff', 'running.long_run_length', o.over, {
			kept: 'The long run',
			given: `your ${minutes}-minute sessions`,
			reason: clip(
				`The long run builds the endurance ${clip(goal.title, 60)} needs, so it may run longer than your ${minutes}-minute sessions. Every other run keeps to them.`,
				200
			)
		});
	}
}
