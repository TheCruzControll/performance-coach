/**
 * Marathon and half-marathon blocks as week plans (m7-plan endurance-blocks; PRD §5): base, build
 * and peak weeks counted back from race day, then the taper and the race week. Each week is a
 * skeleton: its Monday, kind (kinds.ts BLOCK_WEEK_KINDS), phase, targets and planned mileage, why
 * the mileage moved, its quality sessions and race-specific work, from rules/endurance.ts. The
 * generator fills in sessions. Pure and deterministic.
 */
import { addDays, daysBetween, mondayOf } from '../../calendar.ts';
import type { IsoDate } from '../../calendar.ts';
import type { RunSegment, WeekTargets } from '../../training/types.ts';
import type { WeekKind } from '../../training/vocabulary.ts';
import { paceFor, zoneOf } from '../paces.ts';
import type { TrainingPaces } from '../paces.ts';
import { OUTLINES, weekTargets } from '../rules/blocks.ts';
import { ENDURANCE, hooksFor } from '../rules/endurance.ts';
import type { EnduranceEvent, RaceWork } from '../rules/endurance.ts';
import { ASSUMED_EASY_PACE, EFFORTS, RUN_DISTANCE_STEP } from '../rules/running.ts';
import { BLOCK_WEEK_KINDS } from './kinds.ts';
import type { BLOCK_PHASES } from './kinds.ts';
import { taperWeeks } from './taper.ts';

/** A marathon's or a half's phases. */
export type EndurancePhase = (typeof BLOCK_PHASES)[EnduranceEvent][number];

type Role = 'base' | 'build' | 'peak' | 'taper';

/** A race-specific workout: its main segment, labelled. Only marathon pace has a distance. */
export interface RaceWorkout {
	work: RaceWork;
	label: string;
	segment: RunSegment;
}

/** Why a week's mileage is what it is, against the biggest week before it. */
export interface VolumeChange {
	/** The change on the biggest week before, as a fraction (0.1 = +10 %). */
	share: number;
	ruleKey:
		| 'endurance.increase'
		| 'endurance.regain'
		| 'endurance.cutback'
		| 'endurance.ceiling'
		| 'taper.marathon'
		| 'taper.half';
}

/** One week of a marathon or half block, before it has sessions. */
export interface EnduranceWeek {
	startsOn: IsoDate;
	kind: WeekKind;
	phase: EndurancePhase;
	targets: WeekTargets & { running: NonNullable<WeekTargets['running']> };
	/** The week's planned running, in metres. */
	volumeMetres: number;
	change: VolumeChange;
	/** Quality sessions this week: the phase's hooks. */
	quality: number;
	raceWork: RaceWorkout[];
	/** The first day with no heavy lower-body work, when this week reaches it; otherwise null. */
	noHeavyLowerFrom: IsoDate | null;
}

export interface EnduranceInput {
	/** The block's first day; it starts on that day's Monday. */
	startsOn: IsoDate;
	raceOn: IsoDate;
	/** This week's running before the block, in metres: week 1 runs it. */
	startVolume: number;
	/** The longest recent run, in metres, or null when none is known. */
	longestRun: number | null;
	/** The biggest weekly mileage held recently, and how many weeks ago, or null. */
	level: { metres: number; weeksAgo: number } | null;
	/** Training paces, for the segments and the long run's time cap; null sets them by effort. */
	paces?: TrainingPaces | null;
}

const WORK: Readonly<Record<EnduranceEvent, Readonly<Record<Role, readonly RaceWork[]>>>> =
	ENDURANCE.race_work;
const RANGES: Readonly<
	Record<EnduranceEvent, Readonly<Record<'base' | 'build', readonly number[]>>>
> = ENDURANCE.phases;
const { cutback: CUTBACK, regain: REGAIN, long_run: LONG, marathon_pace: MP } = ENDURANCE;

const down = (metres: number) => Math.floor(metres / RUN_DISTANCE_STEP) * RUN_DISTANCE_STEP;
const hundredths = (n: number) => Math.round(n * 100) / 100;

/** Base and build weeks for `rest` weeks before the peak: the base gives way first. */
function split(event: EnduranceEvent, rest: number): { base: number; build: number } {
	const [baseMin = 0, baseMax = 0] = RANGES[event].base;
	const [buildMin = 0, buildMax = 0] = RANGES[event].build;
	const build = Math.max(Math.min(buildMin, rest), Math.min(buildMax, rest - baseMin));
	if (rest - build > baseMax) {
		throw new RangeError(
			`A ${event} block has at most ${baseMax + buildMax} weeks before its peak`
		);
	}
	return { base: rest - build, build };
}

/** A race workout's main segment; marathon pace covers `metres` of the long run. */
function segmentOf(
	work: RaceWork,
	metres: number | null,
	paces: TrainingPaces | null
): RaceWorkout {
	const { segment: kind, label } = work === 'marathon_pace' ? MP : ENDURANCE.quality[work];
	let pace: readonly [number, number] | null = paces ? paceFor(kind, paces) : null;
	// 10K pace sits between threshold's fast end and VO2max's slow end.
	if (paces && work === 'intervals')
		pace = [paceFor('interval', paces)[1], paceFor('tempo', paces)[0]];
	return {
		work,
		label,
		segment: {
			kind,
			repeatGroup: null,
			repeats: null,
			distanceMetres: work === 'marathon_pace' ? metres : null,
			durationSeconds: null,
			paceMinSecondsPerKm: pace?.[0] ?? null,
			paceMaxSecondsPerKm: pace?.[1] ?? null,
			hrZone: zoneOf(kind),
			targetRpe: work === 'marathon_pace' ? MP.rpe : EFFORTS[kind as 'tempo' | 'interval'].rpe
		}
	};
}

/**
 * The weeks of a `event` block from `startsOn`'s Monday to the week of `raceOn`: base and build
 * (every 4th a cutback), the peak (OUTLINES' weeks), the taper (TAPERS' weeks) and the race
 * week. Throws a RangeError for a runway shorter than the peak and taper, or longer than the
 * phases allow.
 */
export function enduranceWeeks(event: EnduranceEvent, input: EnduranceInput): EnduranceWeek[] {
	const { raceOn, startVolume, longestRun, level, paces = null } = input;
	const first = mondayOf(input.startsOn);
	const raceWeek = mondayOf(raceOn);
	const taper = taperWeeks(event, 'primary', raceOn);
	const tapered = taper.weeks.map((w) => w.startsOn);
	const peakWeeks = OUTLINES[event].find(([phase]) => phase === 'marathon_peak')![1] ?? 0;
	const total = daysBetween(first, raceWeek) / 7 + 1;
	const ahead = (tapered[0] ? daysBetween(tapered[0], raceWeek) / 7 : 0) + 1;
	const rest = total - ahead - peakWeeks;
	if (!(startVolume > 0) || rest < 0) {
		throw new RangeError(
			`A ${event} block needs mileage and ${peakWeeks + ahead} weeks to race day`
		);
	}
	const { base, build } = split(event, rest);
	const cap = LONG.cap[event];
	const longPace = paces ? paceFor('long', paces)[1] : ASSUMED_EASY_PACE;
	const longCap = Math.min(cap.metres, (cap.minutes * 60 * 1000) / longPace);
	const noHeavyFrom = addDays(raceOn, -ENDURANCE.strength.noHeavyLowerDays);

	let biggest = startVolume;
	let longest = longestRun ?? 0;
	let peak = startVolume;
	const weeks: EnduranceWeek[] = [];
	for (let i = 0; i < total; i++) {
		const startsOn = addDays(first, 7 * i);
		const role: Role =
			i < base ? 'base' : i < base + build ? 'build' : i < rest + peakWeeks ? 'peak' : 'taper';
		const phase = `${event}_${role}` as EndurancePhase;
		const hooks = hooksFor(phase)!;
		const kinds = BLOCK_WEEK_KINDS[event];
		let kind: WeekKind = kinds[role];
		let volume: number;
		let ruleKey: VolumeChange['ruleKey'] = 'endurance.increase';
		if (role === 'taper') {
			const at = tapered.indexOf(startsOn);
			const factor = at >= 0 ? taper.weeks[at]!.factor : weekTargets('event', 0).runVolumeFactor;
			volume = down(peak * factor);
			ruleKey = `taper.${event}`;
			if (startsOn === raceWeek) kind = kinds.race;
		} else if (i === 0) {
			volume = startVolume;
		} else if (role !== 'peak' && (i + 1) % CUTBACK.every === 0) {
			volume = down(biggest * CUTBACK.factor);
			kind = kinds.cutback;
			ruleKey = 'endurance.cutback';
		} else {
			const rate = hooks.runWeeklyIncreaseMax ?? 0;
			const regaining =
				rate > 0 &&
				level !== null &&
				level.weeksAgo + i <= REGAIN.withinWeeks &&
				level.metres > biggest * (1 + rate);
			const grown = regaining
				? Math.min(level.metres, biggest * (1 + REGAIN.max))
				: biggest * (1 + rate);
			if (regaining) ruleKey = 'endurance.regain';
			const ceiling = startVolume * ENDURANCE.ceiling.maxFactor;
			if (grown > ceiling) ruleKey = 'endurance.ceiling';
			volume = Math.max(biggest, down(Math.min(grown, ceiling)));
		}
		const change = { share: hundredths(volume / biggest - 1), ruleKey };
		biggest = Math.max(biggest, volume);
		if (role !== 'taper') peak = biggest;

		const isRace = kind === kinds.race;
		const share = hooks.longRunShareMax! * volume;
		const grow = i > 0 && role !== 'taper' ? LONG.stepMetres : 0;
		const long = isRace
			? null
			: down(Math.min(longestRun === null && i === 0 ? share : longest + grow, share, longCap));
		if (long !== null) longest = Math.max(longest, long);

		const builds = Math.max(1, build - 1);
		const mpShare =
			role === 'build'
				? MP.share[0] + ((MP.share[1] - MP.share[0]) * (i - base)) / builds
				: role === 'peak'
					? MP.share[1]
					: MP.share[0];
		const raceWork = isRace
			? []
			: WORK[event][role].map((work) =>
					segmentOf(work, long === null ? null : down(long * mpShare), paces)
				);
		const lifting = (ENDURANCE.strength.maintenanceIn as readonly Role[]).includes(role);
		const fixed = isRace ? weekTargets('event', 0) : null;
		weeks.push({
			startsOn,
			kind,
			phase,
			targets: {
				rpeCap: fixed?.rpeCap ?? ENDURANCE.strength.rpeCap,
				volumeFactor: role === 'taper' ? hundredths(volume / peak) : 1,
				loadStep: 0,
				runVolumeFactor: hundredths(volume / startVolume),
				running: {
					longRunMetres: long || null,
					raceSpecific: raceWork[0]?.work ?? null,
					cutback: kind === kinds.cutback
				},
				...(lifting && { maintenance: ['strength' as const] })
			},
			volumeMetres: volume,
			change,
			quality: isRace ? 0 : hooks.qualityPerWeek!,
			raceWork,
			noHeavyLowerFrom:
				addDays(startsOn, 6) >= noHeavyFrom
					? startsOn > noHeavyFrom
						? startsOn
						: noHeavyFrom
					: null
		});
	}
	return weeks;
}
