/**
 * The season's road (m7-plan season-road; PRD §5): the season's windows (windows.ts) as dated
 * blocks, from rules/road.ts.
 * - planSeason(input, startsOn, options): the first block planned with its weeks, from the block
 *   type's own module (strength, hypertrophy, endurance, fight-camp or maintenance), then outlines
 *   phase by phase, each event's run-up ending on its Sunday. Deloads follow the cadence, never
 *   within TAPER_GUARD weeks of a taper, and every event gets its taper. A first program keeps
 *   M3's planFirstBlock where M7 plans no differently (FIRST_PROGRAM), and only a first program
 *   gets a baseline week; `continuity` carries the current phase's step on. The road stays inside
 *   PLAN_BUDGET, merging its far outlines, or is refused when the past blocks leave no room.
 * - toBlockPlans(blocks): the blocks as the plan stores them, with no sessions yet.
 * Pure and deterministic.
 */
import { addDays, daysBetween, mondayOf } from '../../calendar.ts';
import type { IsoDate } from '../../calendar.ts';
import type { ExperienceLevel } from '../../profile/catalog.ts';
import type { BlockPlan, DecisionPlan, WeekTargets } from '../../training/types.ts';
import { DECISION_KINDS, PHASE_LABEL } from '../../training/vocabulary.ts';
import type { Phase, WeekKind } from '../../training/vocabulary.ts';
import { planFirstBlock, structureOf } from '../blocks.ts';
import { DecisionLog } from '../decisions.ts';
import { clip } from '../demand.ts';
import type { ProgrammingInput } from '../input.ts';
import { doseBand } from '../priority/doses.ts';
import type { GoalDose } from '../priority/doses.ts';
import { eventKindOf } from '../priority/weights.ts';
import { weekTargets } from '../rules/blocks.ts';
import { CADENCE, TARGETS } from '../rules/deload.ts';
import { ENDURANCE } from '../rules/endurance.ts';
import { HARD_SPARRING, LAST_HARD_SPARRING } from '../rules/fight-camp.ts';
import { HYPERTROPHY } from '../rules/hypertrophy.ts';
import { MAINTENANCE_BLOCK } from '../rules/maintenance.ts';
import {
	BLOCK_LENGTH,
	FIRST_PROGRAM,
	HORIZON,
	OUTLINE_PHASES,
	PLAN_BUDGET,
	TAPER_GUARD
} from '../rules/road.ts';
import { RECOVERY } from '../rules/season.ts';
import { TAPERS } from '../rules/taper.ts';
import { chooseSplit } from '../splits.ts';
import { deloadWeek, scheduledDeloads } from './deload.ts';
import { enduranceWeeks } from './endurance.ts';
import { fightCampWeeks } from './fight-camp.ts';
import { hypertrophyWeeks } from './hypertrophy.ts';
import { BLOCK_WEEK_KINDS, LIGHT_RUNNING_WEEK_KINDS } from './kinds.ts';
import type { BlockType } from './kinds.ts';
import { maintenanceWeeks } from './maintenance.ts';
import { meetSequence, strengthWeeks } from './strength.ts';
import type { StrengthPhase } from './strength.ts';
import { taperWeeks } from './taper.ts';
import { SEASON_RULE_KEYS, seasonWindows } from './windows.ts';
import type { SeasonWindow } from './windows.ts';

/** One week of a planned block, before it has sessions. */
export interface SkeletonWeek {
	kind: WeekKind;
	startsOn: IsoDate;
	targets: WeekTargets;
}

export interface BlockSkeleton {
	/** The M7 block type; null for M3's own block (a kept first block, or a shorter race). */
	type: BlockType | null;
	phase: Phase;
	name: string;
	startsOn: IsoDate;
	endsOn: IsoDate;
	outline: boolean;
	goalRefs: string[];
	/** The planned block's weeks; none for an outline. */
	weeks: SkeletonWeek[];
	/** The event the block ends on, when it is the last block of that event's run-up. */
	event: string | null;
}

export interface SeasonOptions {
	/** The phase under way and its weeks done, for a re-plan or a next block: no baseline week. */
	continuity?: { phase: Phase; weeksDone: number };
	/** Start with a deload week. */
	deloadFirst?: boolean;
	/** The blocks the plan's version keeps before these (PLAN_BUDGET counts them). */
	pastBlocks?: number;
}

export interface SeasonPlan {
	blocks: BlockSkeleton[];
	/** The first block's weeks, each with the doses of every goal held at maintenance. */
	dosesByWeek: { startsOn: IsoDate; doses: GoalDose[] }[];
	/** Their refs count the past blocks first. */
	decisions: DecisionPlan[];
}

export interface SeasonRefusal {
	refusal: typeof PLAN_BUDGET.refusal;
	why: string;
}

type Week = Omit<SkeletonWeek, 'startsOn'> & { phase: Phase };
type Run = readonly [Phase, number];

const TAPER_PHASES: readonly Phase[] = ['taper', 'marathon_taper', 'half_taper'];
const BUILDING: readonly WeekKind[] = ['accumulation', 'intensification', 'build', 'base'];
const CADENCED: readonly (BlockType | null)[] = ['strength', 'hypertrophy', 'fight_camp', null];
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const sundayOf = (date: IsoDate) => addDays(mondayOf(date), 6);
const weeksFrom = (from: IsoDate, to: IsoDate) => Math.floor(daysBetween(from, to) / 7);
const within = (date: IsoDate, b: { startsOn: IsoDate; endsOn: IsoDate }) =>
	b.startsOn <= date && date <= b.endsOn;

/** The Sunday ending the road: the last dated goal's event, recovery and tail, or its target date. */
function horizonOf(input: ProgrammingInput, startsOn: IsoDate): IsoDate {
	const goals = input.maintenance ? input.paused : input.goals;
	const ends = goals.flatMap((g) => {
		const kind = eventKindOf(g);
		const event = kind
			? [addDays(sundayOf(g.eventDate!), 7 * (RECOVERY.weeks[kind] + HORIZON.tailWeeks))]
			: [];
		return g.targetDate ? [...event, g.targetDate] : event;
	});
	const last = ends.reduce((a, b) => (a > b ? a : b), startsOn);
	const weeks = Math.min(
		HORIZON.maxWeeks,
		Math.max(HORIZON.minWeeks, weeksFrom(startsOn, last) + 1)
	);
	return addDays(startsOn, 7 * weeks - 1);
}

/** The experience the window's leader trains at. */
function levelOf(input: ProgrammingInput, w: SeasonWindow): ExperienceLevel {
	const goal = input.goals[w.leader ? input.refs.goals.indexOf(w.leader.goalId) : -1];
	const discipline = goal?.disciplines[0] ?? input.disciplines[0];
	return (discipline && input.experience[discipline]) || 'novice';
}

/** Phases with their weeks: the fixed ones from the end, `null` taking the weeks left. */
function allocate(table: readonly (readonly [Phase, number | null])[], weeks: number): Run[] {
	let left = weeks;
	const counts = table.map(() => 0);
	for (let i = table.length - 1; i >= 0; i--) {
		const fixed = table[i]![1];
		if (fixed !== null) left -= counts[i] = Math.min(fixed, left);
	}
	const flexible = table.findIndex(([, n]) => n === null);
	counts[Math.max(0, flexible)]! += left;
	return table.flatMap(([phase], i): Run[] => (counts[i] ? [[phase, counts[i]!]] : []));
}

/** `plan()`, or none when a module refuses its input as out of range. */
function attempt<T>(plan: () => T[]): T[] {
	try {
		return plan();
	} catch (error) {
		if (error instanceof RangeError) return [];
		throw error;
	}
}

const runsOf = (weeks: readonly Week[]): Run[] =>
	weeks.reduce<[Phase, number][]>((runs, { phase }) => {
		const last = runs.at(-1);
		if (last?.[0] === phase) last[1] += 1;
		else runs.push([phase, 1]);
		return runs;
	}, []);

/**
 * The weeks a date-bound module plans for `total` weeks from `start`: a fight camp, a marathon or
 * half from the owner's mileage, or a meet's sequence. A week before the module's first is its
 * first week again: the run-up starts now. Null where no module is bound to the window's event.
 */
function datedWeeks(
	w: SeasonWindow,
	start: IsoDate,
	total: number,
	input: ProgrammingInput
): Week[] | null {
	const { event, blockType: type } = w;
	if (!event) return null;
	const level = levelOf(input, w);
	let weeks: (Week & { startsOn: IsoDate })[] = [];
	if (type === 'fight_camp') {
		const spars = input.muayThai?.sparringPerWeek !== 0;
		const camp = { fightOn: event.date, startsOn: start, level, spars };
		weeks = attempt(() => fightCampWeeks({ ...camp, sessionsAvailable: input.daysPerWeek }));
	} else if ((type === 'marathon' || type === 'half') && input.running?.weeklyMetres) {
		const { weeklyMetres: startVolume, longestRunMetres: longestRun } = input.running;
		// A run-up longer than the phases allow starts later; a shorter one has no plan here.
		for (let lead = 0; !weeks.length && lead < weeksFrom(start, event.date); lead++) {
			const startsOn = addDays(start, 7 * lead);
			weeks = attempt(() =>
				enduranceWeeks(type, { startsOn, raceOn: event.date, startVolume, longestRun, level: null })
			);
		}
	} else if (type === 'strength' && w.phases.includes('taper')) {
		const meetWeek = mondayOf(event.date);
		const sequence = attempt(() => meetSequence(weeksFrom(start, meetWeek), level));
		weeks = sequence.map((week, i) => ({
			...week,
			startsOn: addDays(meetWeek, 7 * (i + 1 - sequence.length))
		}));
	}
	if (!weeks.length) return null;
	return Array.from({ length: total }, (_, i) => {
		const date = addDays(start, 7 * i);
		const week =
			weeks.find((x) => x.startsOn === date) ??
			(date < weeks[0]!.startsOn ? weeks[0]! : weeks.at(-1)!);
		return { kind: week.kind, phase: week.phase, targets: structuredClone(week.targets) };
	});
}

/** `total` weeks of `phase` from `start` where no date-bound module plans them. */
function phaseWeeks(
	w: SeasonWindow,
	phase: Phase,
	start: IsoDate,
	total: number,
	input: ProgrammingInput
): Week[] {
	const level = levelOf(input, w);
	const each = (week: (i: number) => Omit<Week, 'phase'>) =>
		Array.from({ length: total }, (_, i) => ({ ...week(i), phase }));
	if (phase === 'recovery')
		return each(() => ({ kind: 'recovery', targets: weekTargets('deload', 0) }));
	if (phase === 'maintenance') {
		const [week] = maintenanceWeeks(w.doses, { weeks: total, level }).weeks;
		return each(() => ({ kind: week!.kind, targets: structuredClone(week!.targets) }));
	}
	if (TAPER_PHASES.includes(phase) && w.event) {
		const { kind: eventKind, date } = w.event;
		const taper = taperWeeks(eventKind, 'primary', date);
		return each((i) => {
			const monday = addDays(start, 7 * i);
			const factor = taper.weeks.find((t) => t.startsOn === monday)?.factor;
			if (monday === mondayOf(date)) return { kind: 'event', targets: weekTargets('event', 0) };
			if (factor === undefined) return { kind: 'build', targets: weekTargets('build', 0) };
			const targets = { ...weekTargets('taper', 0), volumeFactor: factor, runVolumeFactor: factor };
			return { kind: 'taper', targets };
		});
	}
	if (w.blockType === 'hypertrophy') {
		const [lo, hi] = HYPERTROPHY.block.building;
		const band = doseBand(chooseSplit(input, input.daysPerWeek), input.nutritionPhase, 'primary');
		const building = Math.min(hi, Math.max(lo, total - 1));
		const weeks = hypertrophyWeeks({ sets: band }, building, level, input.nutritionPhase);
		return each((i) => weeks[Math.min(i, weeks.length - 1)]!);
	}
	if (w.blockType === 'strength') return strengthWeeks(phase as StrengthPhase, total, level);
	if (w.blockType === 'marathon' || w.blockType === 'half') {
		const role = phase.split('_')[1] as 'base' | 'build' | 'peak';
		return each((i) => ({
			kind: BLOCK_WEEK_KINDS[w.blockType as 'marathon'][role],
			targets: weekTargets('build', i)
		}));
	}
	// M3's own phases: a general block, or a shorter race's run-up.
	const kind: WeekKind =
		phase === 'realization' ? 'peak' : phase === 'intensification' ? 'build' : 'accumulation';
	return each((i) => ({ kind, targets: weekTargets(kind, i) }));
}

/** A window's phases with their weeks. */
function phasesOf(w: SeasonWindow, input: ProgrammingInput): Run[] {
	const dated = datedWeeks(w, w.from, w.weeks, input);
	if (dated) return runsOf(dated);
	if (w.phases.length === 1) return [[w.phases[0]!, w.weeks]];
	const type = w.blockType;
	const table =
		type === 'marathon' || type === 'half' || type === 'strength'
			? OUTLINE_PHASES[type]
			: OUTLINE_PHASES.other;
	return allocate(
		table.filter(([phase]) => w.phases.includes(phase)),
		w.weeks
	);
}

/**
 * The windows with the gap before the first run-up folded into it when `continuity`'s phase opens
 * that run-up and not the gap: a re-plan carries the current phase on to the event, as M3's road
 * did, instead of pausing it.
 */
function carried(
	windows: SeasonWindow[],
	input: ProgrammingInput,
	continuity: SeasonOptions['continuity']
): SeasonWindow[] {
	const [head, next, ...rest] = windows;
	if (!continuity || !head || next?.kind !== 'event' || head.kind === 'event') return windows;
	const opens = (w: SeasonWindow) => phasesOf(w, input)[0]?.[0] === continuity.phase;
	if (head.kind === 'recovery' || opens(head) || !opens(next)) return windows;
	const overlaps = [...head.overlaps, ...next.overlaps];
	const weeks = head.weeks + next.weeks;
	const event = next.event ? `${next.event.title} on ${next.event.date}` : 'the event';
	const why = `${PHASE_LABEL[continuity.phase]} carries on into the run-up to ${event}: ${plural(weeks, 'week')} from now, not paused behind a gap.`;
	const block = {
		...next.facts.block,
		facts: { ...next.facts.block.facts, weeks, startsOn: head.from, reason: clip(why, 200) }
	};
	const facts = { ...next.facts, block };
	return [{ ...next, from: head.from, weeks, overlaps, why, facts }, ...rest];
}

/**
 * The first block's weeks: `length` weeks of the first phase of `w`, its step carried on by
 * `done` weeks already trained, then the baseline, a first deload and the cadence's deloads.
 */
function planFirst(
	w: SeasonWindow,
	phase: Phase,
	segment: number,
	input: ProgrammingInput,
	options: SeasonOptions & { first: boolean }
): Week[] {
	const level = levelOf(input, w);
	const done = options.continuity?.phase === phase ? options.continuity.weeksDone : 0;
	const cadence = CADENCE.weeks[level];
	const [lo, hi] = HYPERTROPHY.block.building;
	const total =
		w.blockType === 'maintenance'
			? options.first
				? BLOCK_LENGTH.first
				: MAINTENANCE_BLOCK.weeks.max
			: w.blockType === 'hypertrophy'
				? Math.min(hi, Math.max(lo, cadence)) + 1
				: w.kind === 'fill'
					? cadence + 1
					: done + segment;
	const length = Math.max(1, Math.min(segment, total - done, BLOCK_LENGTH.maxPlanned));
	const start = addDays(w.from, -7 * done);
	const all =
		datedWeeks(w, start, done + length, input) ?? phaseWeeks(w, phase, start, done + length, input);
	const weeks = all.slice(done);

	const head = weeks[0]!;
	if (options.first && BUILDING.includes(head.kind)) {
		const cap = (n: number) => Math.min(n, FIRST_PROGRAM.baselineRpeCap);
		const { mainLifts } = head.targets;
		head.kind = 'baseline';
		head.targets = {
			...head.targets,
			rpeCap: cap(head.targets.rpeCap),
			loadStep: 0,
			...(mainLifts && { mainLifts: { ...mainLifts, topRpe: cap(mainLifts.topRpe) } })
		};
	}
	const deload = (week: Week) => {
		week.targets = deloadWeek(week.targets, TARGETS, week.kind);
		week.kind = 'deload';
	};
	if (options.deloadFirst) deload(head);
	if (CADENCED.includes(w.blockType) && !TAPER_PHASES.includes(phase)) {
		const event = w.event && w.event.date <= w.to ? w.event : null;
		const taper =
			event &&
			(taperWeeks(event.kind, 'primary', event.date).weeks[0]?.startsOn ?? mondayOf(event.date));
		for (const i of scheduledDeloads(weeks, level)) {
			const ahead = taper ? weeksFrom(addDays(w.from, 7 * i), taper) : Infinity;
			if (ahead > 0 && ahead <= TAPER_GUARD.weeksBefore) continue;
			deload(weeks[i]!);
		}
	}
	return weeks;
}

const outlineOf = (
	w: SeasonWindow,
	phase: Phase,
	startsOn: IsoDate,
	weeks: number
): BlockSkeleton => ({
	type: w.blockType,
	phase,
	name: PHASE_LABEL[phase],
	startsOn,
	endsOn: addDays(startsOn, 7 * weeks - 1),
	outline: true,
	goalRefs: [...w.goalRefs],
	weeks: [],
	event: null
});

/** The outlines of `windows`, phase by phase, from `monday` on: the one it falls in cut short. */
const outlines = (
	windows: readonly SeasonWindow[],
	input: ProgrammingInput,
	monday: IsoDate
): BlockSkeleton[] =>
	windows.flatMap((w) => {
		let startsOn = w.from;
		return phasesOf(w, input).flatMap(([phase, weeks]) => {
			const block = outlineOf(w, phase, startsOn, weeks);
			startsOn = addDays(block.endsOn, 1);
			if (block.endsOn < monday) return [];
			return [block.startsOn < monday ? { ...block, startsOn: monday } : block];
		});
	});

/** `group` as one outline, named for the event it ends on. */
function merged(group: readonly BlockSkeleton[]): BlockSkeleton {
	const last = group.at(-1)!;
	if (group.length === 1) return last;
	const span = (b: BlockSkeleton) => daysBetween(b.startsOn, b.endsOn);
	// The phase and type of the event's own block type: its longest phase.
	const main = group
		.filter((b) => b.type === last.type)
		.reduce((a, b) => (span(b) > span(a) ? b : a));
	return {
		...main,
		name: last.event ? clip(`Road to ${last.event}`, 60) : 'The season ahead',
		startsOn: group[0]!.startsOn,
		endsOn: last.endsOn,
		goalRefs: [...new Set(group.flatMap((b) => b.goalRefs))].slice(0, 20),
		event: last.event
	};
}

/** The road inside PLAN_BUDGET: its far outlines merged as far as needed, or null with no room. */
function fit(road: readonly BlockSkeleton[], past: number): BlockSkeleton[] | null {
	const room = PLAN_BUDGET.blocks - past;
	if (room < 1) return null;
	const [first, ...rest] = road;
	const groups = rest
		.reduce<BlockSkeleton[][]>(
			(all, block) => {
				all.at(-1)!.push(block);
				if (block.event) all.push([]);
				return all;
			},
			[[]]
		)
		.filter((g) => g.length);
	const merges = [
		rest,
		[...(groups[0] ?? []), ...groups.slice(1).map(merged)],
		groups.map(merged),
		rest.length ? [merged(rest)] : [],
		[]
	];
	return [first!, ...merges.find((m) => m.length < room)!];
}

const km = (metres: number) => `${Math.round(metres / 100) / 10} km`;

/**
 * The season from `startsOn`, a Monday: its blocks, the first planned with its weeks, the doses of
 * that block's weeks and the decisions, or the refusal too_many_blocks.
 */
export function planSeason(
	input: ProgrammingInput,
	startsOn: IsoDate,
	options: SeasonOptions = {}
): SeasonPlan | SeasonRefusal {
	const past = options.pastBlocks ?? 0;
	const first = !options.continuity && past === 0;
	const horizon = horizonOf(input, startsOn);
	const windows = carried(seasonWindows(input, startsOn, horizon), input, options.continuity);
	const [head, next] = windows as [SeasonWindow, ...SeasonWindow[]];
	const log = new DecisionLog();
	let decisions: DecisionPlan[] = [];
	let road: BlockSkeleton[];
	let planned = false;

	const kept =
		first &&
		!input.maintenance &&
		((head.kind === 'fill' && head.blockType !== 'hypertrophy') ||
			(head.ruleKey === SEASON_RULE_KEYS.noBuildingGoal && next?.kind === 'event') ||
			(head.blockType === 'marathon' && head.phases.length > 1));
	if (kept) {
		// FIRST_PROGRAM: M3's first block and its road to the next event, unchanged.
		const m3 = new DecisionLog();
		road = planFirstBlock(input, startsOn, m3).map((b) => ({
			...b,
			type: null,
			event: null
		}));
		decisions = m3.list().filter((d) => d.kind === 'block_structure' || d.kind === 'event_taper');
		road.push(...outlines(windows, input, addDays(road.at(-1)!.endsOn, 1)));
	} else {
		const [[phase, segment]] = phasesOf(head, input) as [Run, ...Run[]];
		const weeks = planFirst(head, phase, segment, input, { ...options, first });
		planned = true;
		const block: BlockSkeleton = {
			...outlineOf(head, phase, startsOn, weeks.length),
			outline: false,
			weeks: weeks.map(({ kind, targets }, i) => ({
				kind,
				startsOn: addDays(startsOn, 7 * i),
				targets
			}))
		};
		road = [block, ...outlines(windows, input, addDays(block.endsOn, 1))];
	}
	// A block ending an event's run-up, its event inside, carries the event's name.
	for (const w of windows) {
		const end = road.find((b) => b.endsOn === w.to);
		if (end && w.kind === 'event' && w.event && w.event.date <= w.to) end.event = w.event.title;
	}

	const blocks = fit(road, past);
	if (!blocks) {
		return {
			refusal: PLAN_BUDGET.refusal,
			why: `The plan already keeps ${plural(past, 'block')}, and ${PLAN_BUDGET.blocks} is the most a plan holds with room to re-plan, so a new program has to start from here.`
		};
	}
	const refs = (date: IsoDate) => {
		const i = blocks.findIndex((b) => within(date, b));
		return i < 0 ? [] : [`blocks.${past + i}`];
	};
	const firstBlock = blocks[0]!;
	const covering = windows.filter((w) => w.from <= firstBlock.endsOn);

	for (const w of windows) {
		log.add('block_type_chosen', w.facts.block.ruleKey, refs(w.from), w.facts.block.facts);
		if (w.facts.priority)
			log.add('priority_resolved', w.facts.priority.ruleKey, refs(w.from), w.facts.priority.facts);
	}
	const dosed = new Set<string>();
	for (const { ruleKey, facts } of covering.flatMap((w) => w.facts.doses)) {
		const key = `${ruleKey}:${facts.goal}`;
		if (dosed.has(key)) continue;
		dosed.add(key);
		log.add('maintenance_dose', ruleKey, refs(firstBlock.startsOn), facts);
	}
	for (const w of windows) {
		const own =
			w.kind === 'event' && w.event && w.event.date <= horizon
				? [{ taper: taperWeeks(w.event.kind, 'primary', w.event.date), ...w.event }]
				: [];
		const tapers = [...own.map((t) => ({ ...t, why: TAPERS[t.kind].why })), ...w.overlaps];
		for (const { taper, title, why } of tapers) {
			if (!taper || taper.form === 'none') continue;
			const days = taper.days;
			const steps = days ? [days.factor] : taper.weeks.map((t) => t.factor);
			log.add('taper_planned', taper.ruleKey, refs(days?.from ?? taper.weeks[0]!.startsOn), {
				event: clip(title, 60),
				date: taper.raceOn,
				length: days
					? plural(daysBetween(days.from, taper.raceOn), 'day')
					: plural(taper.weeks.length, 'week'),
				steps: `${steps.map((f) => Math.round(f * 100)).join(', ')} % of the volume`,
				reason: clip(why, 200)
			});
		}
	}

	if (planned) {
		const ref = refs(firstBlock.startsOn);
		const name = clip(firstBlock.name, 60);
		const kinds = firstBlock.weeks.map((w) => w.kind);
		const light: readonly WeekKind[] = LIGHT_RUNNING_WEEK_KINDS;
		const building = firstBlock.weeks.filter((w) => !light.includes(w.kind));
		log.add('block_structure', 'road.season', ref, {
			block: name,
			structure: clip(structureOf(kinds), 200),
			weeks: kinds.length,
			reason: clip(
				`${first && kinds[0] === 'baseline' ? 'Week 1 of a first program is a baseline that sets your numbers. ' : ''}A deload follows every ${CADENCE.weeks[levelOf(input, head)]} loading weeks at your level, never within ${TAPER_GUARD.weeksBefore} weeks of a taper.`,
				200
			),
			notes: ''
		});
		const sets = building.flatMap((w) =>
			w.targets.setsPerGroup ? [w.targets.setsPerGroup.min] : []
		);
		if (sets.length > 1 && sets.at(-1)! > sets[0]!) {
			log.add('volume_progressed', 'hypertrophy.step', ref, {
				block: name,
				stream: 'hard sets a muscle group',
				from: sets[0]!,
				to: sets.at(-1)!,
				step: `up to ${Math.max(...sets.slice(1).map((n, i) => n - sets[i]!))} sets`,
				reason: clip(HYPERTROPHY.step.why, 200),
				ramp: sets.join(', ')
			});
		}
		const longs = building.flatMap((w) =>
			w.targets.running?.longRunMetres ? [w.targets.running.longRunMetres] : []
		);
		if (longs.length > 1 && longs.at(-1)! > longs[0]!) {
			const cap = ENDURANCE.long_run.cap[head.blockType === 'half' ? 'half' : 'marathon'];
			log.add('long_run_progressed', 'endurance.long_run', ref, {
				block: name,
				from: km(longs[0]!),
				to: km(longs.at(-1)!),
				step: km(ENDURANCE.long_run.stepMetres),
				cap: `${km(cap.metres)} or ${cap.minutes / 60} hours`,
				reason: clip(ENDURANCE.long_run.why, 200),
				ramp: longs.map(km).join(', ')
			});
		}
		const sparring = firstBlock.weeks.map((w) => w.targets.combat?.hardSparring ?? 0);
		if (head.event && Math.max(...sparring) > 0) {
			log.add('sparring_load', 'fight_camp.hard_sparring', ref, {
				count: Math.max(...sparring),
				last: addDays(head.event.date, -LAST_HARD_SPARRING.daysOut),
				days: LAST_HARD_SPARRING.daysOut,
				event: clip(head.event.title, 60),
				reason: clip(HARD_SPARRING.why, 200),
				ramp: sparring.join(', ')
			});
		}
	}

	const rank = (d: DecisionPlan) => DECISION_KINDS.indexOf(d.kind);
	decisions = [...decisions, ...log.list()].sort((a, b) => rank(a) - rank(b));
	const dosesByWeek = firstBlock.weeks.map(({ startsOn: monday }) => {
		const w = windows.find((x) => within(monday, { startsOn: x.from, endsOn: x.to }))!;
		const held = w.overlaps.filter((o) => o.from <= monday && monday <= o.to);
		return { startsOn: monday, doses: [...w.doses, ...held.flatMap((o) => o.doses)] };
	});
	return { blocks, dosesByWeek, decisions };
}

/** The blocks as the plan stores them: dated weeks with their targets and no sessions yet. */
export const toBlockPlans = (blocks: readonly BlockSkeleton[]): BlockPlan[] =>
	blocks.map(({ type: _, event: __, weeks, ...block }) => ({
		...block,
		goalRefs: [...block.goalRefs],
		progression: {},
		weeks: weeks.map(({ kind, startsOn, targets }) => ({
			kind,
			startsOn,
			endsOn: addDays(startsOn, 6),
			targets: structuredClone(targets),
			sessions: []
		}))
	}));
