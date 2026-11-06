/**
 * The running week (PRD §5), by the numbers in rules/running.ts:
 * - The runs a week are allocateWeek's (demand.ts), running commitments already counted.
 * - Week 1 is the current weekly volume. With none told it is time-based: easy runs of 30 min
 *   and, unless the runner is new, a 45-minute long run. A running commitment counts in the
 *   week by its duration, at the easy pace in a distance week, and so does a quality session.
 * - Each later week is week 1 × its runVolumeFactor (rules/blocks.ts, so the deload drops it),
 *   and holds never more than 10 % over the most a week before it held.
 * - The long run is at most 30 % of the week and 10 % over the longest run so far. It may outrun
 *   the session length, with a decision; every other run keeps to it.
 * - One quality session a week only for an intermediate or advanced runner or one with a race
 *   ahead, never in week 1 for a new runner. A new runner with no race gets easy runs only.
 * - Paces come from the told easy pace and the latest race (carried to the 10K by Riegel), as
 *   ranges, with a decision saying which; with neither, segments carry RPE and HR zone alone.
 * - Every planned block, and a marathon's outline phases, carry the progression hooks that later
 *   periodisation (M7) adapts.
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
import type { WeekKind } from '../training/vocabulary.ts';
import { cleanFloat, formatDuration } from '../units.ts';
import { nextOrder, sessionPath } from './commitments.ts';
import type { DecisionLog } from './decisions.ts';
import { clip, commitmentQuota, generatedFor } from './demand.ts';
import type { WeekDemand } from './demand.ts';
import { weeksToEvent } from './input.ts';
import type { InputGoal, InputRunning, ProgrammingInput } from './input.ts';
import * as R from './rules/running.ts';
import type { GenerateOptions } from './stage.ts';

type RunType = keyof typeof R.RUNS;
type QualityType = Exclude<RunType, 'easy_run' | 'long_run'>;
/** A run's size: metres or minutes (the week's unit) for an easy or long run, minutes for quality. */
type SizedRun = { type: RunType; size: number };

/** The contract's most sessions a day (orderInDay 1 to 4). */
const ORDER_MAX = 4;
const EASY_MID = (R.EFFORTS.easy.of10k[0] + R.EFFORTS.easy.of10k[1]) / 2;
const steady = (type: RunType) => type === 'easy_run' || type === 'long_run';
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

/** 10K paces in seconds per km, one for easy running and one for quality work; null: unknown. */
interface Paces {
	easy: number | null;
	quality: number | null;
	source: string;
	reason: string;
}

const raceName = (metres: number) => {
	const known = RACE_DISTANCES.find(
		(d) => d !== 'other' && RACE_DISTANCE_INFO[d].metres === metres
	);
	const label = known ? RACE_DISTANCE_INFO[known].label : `${km(metres)} race`;
	return label.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase());
};

function pacesOf(running: InputRunning | null): Paces {
	const told = running?.easyPaceSecondsPerKm ?? null;
	// The latest race; one with no date counts as the oldest.
	const [race] = [...(running?.races ?? [])].sort((a, b) =>
		(a.racedOn ?? '') === (b.racedOn ?? '') ? 0 : (a.racedOn ?? '') < (b.racedOn ?? '') ? 1 : -1
	);
	const fromRace = race
		? (race.timeSeconds * (10_000 / race.distanceMetres) ** R.RIEGEL_EXPONENT) / 10
		: null;
	const fromEasy = told === null ? null : told / EASY_MID;
	const easy = told === null ? null : `your easy pace of ${perKm(told)}`;
	const raced =
		race &&
		`your ${raceName(race.distanceMetres)} in ${formatDuration(race.timeSeconds)}` +
			(race.racedOn ? ` on ${race.racedOn}` : '');
	const rough = 'One race is a rough guide, so each pace is a range.';
	const reason =
		easy && raced
			? `Easy paces come from ${easy}, quality paces from ${raced} by Riegel’s formula. ${rough}`
			: easy
				? `Paces come from ${easy}, so they match what you run now; each is a range around it.`
				: raced
					? `Paces come from ${raced}, carried to the 10K by Riegel’s formula. ${rough}`
					: 'You haven’t told the coach an easy pace or a race time, so runs are set by effort alone.';
	return {
		easy: fromEasy ?? fromRace,
		quality: fromRace ?? fromEasy,
		source:
			[easy && 'your easy pace', raced && 'your race time'].filter(Boolean).join(' and ') ||
			'effort',
		reason: clip(reason, 200)
	};
}

function segment(
	kind: keyof typeof R.EFFORTS,
	tenK: number | null,
	size: { metres?: number; minutes?: number },
	repeats: number | null = null
): RunSegment {
	const { rpe, hrZone, of10k } = R.EFFORTS[kind];
	// The pace range from a 10K pace, fastest first, inside the contract's bounds.
	const pace = (end: 0 | 1) =>
		tenK === null || of10k === null
			? null
			: Math.min(1500, Math.max(120, Math.round(tenK * of10k[end])));
	return {
		kind,
		repeatGroup: repeats === null ? null : 1,
		repeats,
		distanceMetres: size.metres ?? null,
		durationSeconds: size.minutes === undefined ? null : size.minutes * 60,
		paceMinSecondsPerKm: pace(0),
		paceMaxSecondsPerKm: pace(1),
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
	quality: Quality | null;
}

/** The quality session, if the block warrants one: tempo for a half or full marathon. */
function qualityOf(input: ProgrammingInput, paces: Paces): Quality {
	const { warmUpMinutes: warm, coolDownMinutes: cool, tempo, intervals } = R.QUALITY;
	const main = input.sessionMinutes - warm - cool;
	const ends = (middle: RunSegment[]) => [
		segment('warm_up', paces.easy, { minutes: warm }),
		...middle,
		segment('cool_down', paces.easy, { minutes: cool })
	];
	if (input.disciplines.includes('distance_running')) {
		const minutes = Math.min(tempo.minutes, main);
		return {
			type: tempo.type,
			segments: ends([segment('tempo', paces.quality, { minutes })]),
			minutes: warm + minutes + cool,
			words: `${warm} min easy, ${minutes} min at tempo, ${cool} min easy`
		};
	}
	const { workMinutes: work, recoveryMinutes: jog } = intervals;
	const reps = Math.min(intervals.reps, Math.floor(main / (work + jog)));
	return {
		type: intervals.type,
		segments: ends([
			segment('interval', paces.quality, { minutes: work }, reps),
			segment('recovery', null, { minutes: jog }, reps)
		]),
		minutes: warm + reps * (work + jog) + cool,
		words: `${warm} min easy, ${reps} × ${work} min hard with ${jog}-minute jogs, ${cool} min easy`
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

/** The runs of the `k`th planned week, of kind `kind`, by priority: long, quality, then easy. */
function composition(plan: Plan, kind: WeekKind, k: number): RunType[] {
	const { level, race, runs, quality } = plan;
	const long = runs >= 2 && !(level === 'new' && (k === 0 || !race));
	const withQuality =
		quality !== null &&
		R.QUALITY.weeks.includes(kind) &&
		!(k === 0 && (level === 'new' || plan.mode === 'time')) &&
		runs > (long ? 1 : 0);
	const easy = runs - Number(long) - Number(withQuality);
	return [
		...(long ? (['long_run'] as const) : []),
		...(withQuality ? [quality.type] : []),
		...Array.from({ length: easy }, () => 'easy_run' as const)
	];
}

/**
 * Each run's size, given the week's volume (commitments included), the most it may hold and the
 * longest run so far.
 */
function sizeWeek(
	plan: Plan,
	runs: RunType[],
	volume: number,
	most: number,
	longest: number | null
): SizedRun[] {
	const { mode, perMinute, committed, input } = plan;
	const least = mode === 'distance' ? R.MIN_RUN.metres : R.MIN_RUN.minutes;
	const sessionCap = input.sessionMinutes * perMinute;
	const longMax = R.LONG_RUN_EXCEEDS_SESSION ? Infinity : sessionCap;
	const step = longest === null ? Infinity : longest * (1 + R.LONG_RUN_STEP_MAX);
	const long = runs.includes('long_run');
	const quality = runs.some((t) => !steady(t)) ? plan.quality!.minutes : 0;
	const easyRuns = runs.filter((t) => t === 'easy_run').length;
	const left = Math.max(0, Math.min(volume, most) - committed - quality * perMinute);
	// A week too small for its quality session and a run beside it runs easy instead, and one too
	// small for each run to reach MIN_RUN has fewer, all easy, so it holds its volume.
	if (quality && left < least) {
		return sizeWeek(
			plan,
			runs.map((t) => (steady(t) ? t : 'easy_run')),
			volume,
			most,
			longest
		);
	}
	const fits = Math.max(1, Math.floor(left / least));
	if (fits < runs.filter(steady).length) {
		const easy = Array<RunType>(fits).fill('easy_run');
		return sizeWeek(plan, [...runs.filter((t) => !steady(t)), ...easy], volume, most, longest);
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
		const share = R.LONG_RUN_SHARE_MAX * volume;
		longSize = fit(Math.min(share, left - easyRuns * least), Math.min(longMax, step));
		easySize = fit(easyRuns ? (left - longSize) / easyRuns : 0, Math.min(sessionCap, longSize));
	} else {
		easySize = fit(left / easyRuns, Math.min(sessionCap, step));
	}
	return runs.map((type): SizedRun => ({
		type,
		size: type === 'long_run' ? longSize : type === 'easy_run' ? easySize : quality
	}));
}

/** The runs in the order of their dates: easy runs around a midweek quality session, long last. */
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
	const hooks = (block: BlockPlan) => ({ ...block.progression, ...R.MARATHON_HOOKS[block.phase] });
	const runs = generatedFor(demand.allocation, 'runs');
	if (!runs) return blocks.map((block) => ({ ...block, progression: hooks(block) }));

	const levels = [input.experience.running, input.experience.distance_running];
	const running = input.running;
	const paces = pacesOf(running);
	const easyPace = paces.easy === null ? R.ASSUMED_EASY_PACE : paces.easy * EASY_MID;
	const mode = (running?.weeklyMetres ?? 0) > 0 ? 'distance' : 'time';
	const perMinute = mode === 'time' ? 1 : 60_000 / easyPace;
	const clubs = input.commitments.filter((c) => commitmentQuota(c) === 'runs');
	const clubMinutes = clubs.reduce((sum, c) => sum + c.days.length * c.durationMinutes, 0);
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
		perMinute
	};
	const why = noQuality(base);
	const plan: Plan = { ...base, quality: why ? null : qualityOf(input, paces) };
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
				firstRuns.reduce((n, t) => n + (t === 'long_run' ? longMinutes : easyMinutes), 0);
	const progression = {
		[mode === 'distance' ? 'runWeek1Metres' : 'runWeek1Minutes']: week1,
		runWeeklyIncreaseMax: R.RUN_WEEKLY_INCREASE_MAX,
		longRunShareMax: R.LONG_RUN_SHARE_MAX,
		longRunStepMax: R.LONG_RUN_STEP_MAX
	};

	let k = 0;
	// The most a week has held, which the 10 % rule reads.
	let most = 0;
	let longest = mode === 'distance' ? (running?.longestRunMetres ?? null) : null;
	let planned = 0;
	let week1Runs = 0;
	let dropped = 0;
	const quality: string[] = [];
	const over: string[] = [];
	const result = blocks.map((block, b) => {
		if (block.outline) return { ...block, progression: hooks(block) };
		const weeks = block.weeks.map((week, w) => {
			const volume = k === 0 ? week1 : week1 * week.targets.runVolumeFactor;
			// The 10 % rule caps what the week holds; the long run's share reads its volume, since
			// three runs hold at most 90 % of what it reads and would hold every week to week 1's.
			const limit = k === 0 ? volume : most * (1 + R.RUN_WEEKLY_INCREASE_MAX);
			const sized = sizeWeek(plan, composition(plan, week.kind, k), volume, limit, longest);
			const holds = sized.reduce(
				(sum, r) => sum + (steady(r.type) ? r.size : r.size * perMinute),
				plan.committed
			);
			most = Math.max(most, holds);
			longest = Math.max(longest ?? 0, ...sized.filter((r) => steady(r.type)).map((r) => r.size));
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
			}
			const cap = week.targets.rpeCap;
			kept.forEach((run, d) => {
				const date = dates[d]!;
				const minutes = minutesOf(run);
				const size = mode === 'distance' ? { metres: run.size } : { minutes: run.size };
				const segments = steady(run.type)
					? [segment(run.type === 'long_run' ? 'long' : 'easy', paces.easy, size)]
					: plan.quality!.segments;
				const path = sessionPath(b, w, sessions.length);
				if (run.type === 'long_run' && minutes > input.sessionMinutes) over.push(path);
				if (!steady(run.type)) quality.push(path);
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
					instructions: null,
					notes: null,
					segments: segments.map((s) => ({ ...s, targetRpe: Math.min(s.targetRpe!, cap) }))
				});
			});
			k += 1;
			return { ...week, sessions };
		});
		return { ...block, progression: { ...hooks(block), ...progression }, weeks };
	});

	recordRuns(
		plan,
		{ why, from: firstPlannedDay, paces, week1, planned, week1Runs, dropped, quality, over },
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
	dropped: number;
	quality: string[];
	over: string[];
}

function recordRuns(plan: Plan, o: Outcome, goal: InputGoal, log: DecisionLog) {
	const { input, mode, level, race } = plan;
	const minutes = input.sessionMinutes;
	const clubMinutes = plan.committed / plan.perMinute;
	const club = clubMinutes
		? `, your running commitments counted by their ${Math.round(clubMinutes)} min${mode === 'distance' ? ' at your easy pace' : ''}`
		: '';
	const long = composition(plan, 'baseline', 0).includes('long_run');
	const { easyMinutes, longMinutes } = R.TIME_BASED_WEEK;
	const timed =
		`easy runs of ${easyMinutes} min at RPE ${R.EFFORTS.easy.rpe}` +
		(long ? ` and a ${longMinutes}-minute long run` : '');
	const none =
		input.running?.weeklyMetres === 0
			? 'you don’t run at the moment'
			: 'you haven’t said how much you run';
	log.add('run_volume', `running.${mode}_week`, ['blocks.0.weeks.0'], {
		volume: `${mode === 'distance' ? km(o.planned) : `${Math.round(o.planned)} min`} over ${o.week1Runs + plan.committedRuns} runs`,
		basis: clip(
			mode === 'distance'
				? `the ${km(o.week1)} a week you run now${club}`
				: `time and effort, since ${none}: ${timed}${club}`,
			200
		),
		step: `${R.RUN_WEEKLY_INCREASE_MAX * 100} %`,
		notes: clip(
			(mode === 'distance' && o.planned < R.UNDER_VOLUME * o.week1
				? ` The long run is held to ${R.LONG_RUN_SHARE_MAX * 100} % of the week and no other run outgrows it or your ${minutes}-minute sessions, so week 1 holds ${km(o.planned)}.`
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
	const told = o.paces.source === 'effort' ? 'effort' : 'told';
	const { source, reason } = o.paces;
	log.add('run_pace_source', `running.paces_from_${told}`, [], { source, reason });
	const q = plan.quality;
	const name = q?.type === 'tempo_run' ? 'tempo run' : 'interval session';
	const warrant = race
		? `${clip(race.title, 50)} on ${race.eventDate} is ahead`
		: `You run at ${level} level`;
	const later =
		level === 'new' || mode === 'time' ? ' It starts after week 1, which sets your baseline.' : '';
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
