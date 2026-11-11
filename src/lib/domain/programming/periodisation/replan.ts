/**
 * Re-plans (m7-plan replan-domain; PRD §5; docs/adr/NNNN-replans-as-versions.md): each directive
 * as one deterministic change, by one of three mechanisms (rules/replan.ts MECHANISMS):
 * - regenerate (priorities, block): the blocks from `from` are planned again. A block running
 *   across `from` is cut on the Sunday before; one starting on or after it is replaced, never cut
 *   to zero weeks. New priorities from the program's own start: generateProgram plans it all
 *   again. Otherwise (a chosen block too, even from the start: generateProgram cannot take a chosen
 *   phase, so the block it replaces is `previous`) M6's generateNextBlock plans the new block with
 *   no bridge, every still-eligible exercise kept and none rotated, and the season (planSeason,
 *   carrying the phase under way on) outlines the rest.
 *   After an outline nothing is planned in detail, so the new block is an outline too.
 * - splice (taper): the event's taper weeks are taperSessions of the current weeks, in a taper
 *   block cut into the event-aligned one; a mini-taper changes its days in place. Every block
 *   after the event is kept.
 * - in place (deload): the target week's sessions still ahead (dated today or later, with no
 *   workout) get deloadSessions' values, and the week becomes a deload with deload targets.
 * Event dates never move and nothing before `from` changes. Each case it cannot plan is a refusal
 * with its sentence (REFUSALS).
 *
 * - replanStart(today, touched): the Monday a regenerating or splicing re-plan starts on
 * - replanSkeleton(input, options): what changes and where, from today's profile, or a refusal
 * - generateReplan(input, skeleton, previous): the new version, checked by programPlanSchema, its
 *   decisions (replanned first), the fingerprint (today's profile, the directive, the base version
 *   and from, never the actuals) and the shape digest (never the loads)
 * Pure and deterministic.
 */
import { addDays, daysBetween, mondayOf } from '../../calendar.ts';
import type { IsoDate } from '../../calendar.ts';
import type { ReplanDirective } from '../../training/replan.ts';
import { programPlanSchema } from '../../training/schemas.ts';
import type { BlockPlan, DecisionPlan, ProgramPlan, WeekPlan } from '../../training/types.ts';
import { PHASE_LABEL } from '../../training/vocabulary.ts';
import type { Phase } from '../../training/vocabulary.ts';
import { validate } from '../../validation.ts';
import { DecisionLog } from '../decisions.ts';
import { clip } from '../demand.ts';
import { isEligible } from '../eligibility.ts';
import { GeneratedPlanError, generateProgram } from '../generate.ts';
import { toExerciseKey } from '../input.ts';
import type { ProgrammingInput } from '../input.ts';
import { generateNextBlock } from '../next-block/generate.ts';
import type { PreviousBlock } from '../next-block/generate.ts';
import { eventKindOf, leaderOn } from '../priority/weights.ts';
import { canonicalJson, fingerprint, fnv1a64 } from '../random.ts';
import { shapeDigest } from '../replan/changes.ts';
import { DELOAD_AFTER_WEEKS } from '../review/cycle.ts';
import { DIRECTIVE_RULES, modifiableSubset } from '../review/directives.ts';
import type { CycleDirectives } from '../review/directives.ts';
import { TARGETS } from '../rules/deload.ts';
import { CONFLICTS } from '../rules/priority.ts';
import {
	DELOAD_HOLD,
	MECHANISMS,
	mechanismOf,
	REFUSALS,
	REPLAN_GENERATOR_ID
} from '../rules/replan.ts';
import type { ReplanMechanism, ReplanRefusalReason } from '../rules/replan.ts';
import { PLAN_BUDGET } from '../rules/road.ts';
import { BY_PRIORITY, TAPERS } from '../rules/taper.ts';
import { exerciseOf } from '../selection.ts';
import { deloadSessions, deloadWeek } from './deload.ts';
import type { SessionOptions } from './deload.ts';
import { BLOCK_PHASES } from './kinds.ts';
import { planSeason, toBlockPlans } from './season.ts';
import type { BlockSkeleton, SeasonPlan } from './season.ts';
import { taperSessions, taperWeeks } from './taper.ts';
import type { TaperPlan } from './taper.ts';

export interface ReplanOptions {
	/** The owner's local today. */
	today: IsoDate;
	/** replanStart's Monday; a deload starts on its own week. */
	from: IsoDate;
	/** The version re-planned. */
	current: ProgramPlan;
	directive: ReplanDirective;
	baseVersionNumber: number;
	/** The sessions a workout started (by day and place in it): never changed. */
	started?: readonly { date: IsoDate; orderInDay: number }[];
	/** M3's catalogueDigest for the library the input was built from. */
	catalogueDigest?: string;
}

export interface ReplanRefusal {
	refusal: ReplanRefusalReason;
	why: string;
}

export interface ReplanSkeleton {
	directive: ReplanDirective;
	mechanism: ReplanMechanism;
	/** The first day the new version may differ on: a Monday. */
	from: IsoDate;
	today: IsoDate;
	current: ProgramPlan;
	/** The current blocks before the change, one running across it cut on the Sunday before. */
	before: BlockPlan[];
	/** Where a block was cut; null when none was. */
	cutAt: IsoDate | null;
	/** The indexes of the current blocks the change replaces or rewrites. */
	replaces: number[];
	/** The new block, the taper or the deload week. */
	dates: { startsOn: IsoDate; endsOn: IsoDate; weeks: number };
	/** Regenerated through generateProgram from the program's own start. */
	full: boolean;
	/** The new block's directives (the season's weekPlan when it plans one); null with none. */
	directives: CycleDirectives | null;
	/** The road after the new block (and the new block, when it is an outline). */
	outline: BlockSkeleton[];
	/** The current blocks kept after the change. */
	after: BlockPlan[];
	taper: TaperPlan | null;
	/** The season's decisions for the outline, their refs in the new version's numbering. */
	decisions: DecisionPlan[];
	fingerprint: string;
	/** The sessions a workout started, as `date#orderInDay`. */
	started: string[];
	/** The block a regenerated block continues from, as planned; null with none. */
	previous: BlockPlan | null;
}

export interface ReplanPrevious extends Omit<PreviousBlock, 'block'> {
	/** A deload's paces and plates (deloadSessions' options). */
	sessions?: SessionOptions;
}

export interface Replan {
	plan: ProgramPlan;
	/** The new version's outline blocks. */
	outline: BlockPlan[];
	/** The weeks a splice or a deload rewrote, as they now stand; none for a regenerate. */
	weeks: WeekPlan[];
	/** This re-plan's decisions, replanned first, their refs in the new version's numbering. */
	decisions: DecisionPlan[];
	fingerprint: string;
	shapeDigest: string;
}

type Base = Pick<
	ReplanSkeleton,
	'directive' | 'mechanism' | 'from' | 'today' | 'current' | 'fingerprint' | 'started'
>;
type Directive<K extends ReplanDirective['kind']> = Extract<ReplanDirective, { kind: K }>;

const sundayOf = (date: IsoDate) => addDays(mondayOf(date), 6);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const sessionKey = (s: { date: IsoDate; orderInDay: number }) => `${s.date}#${s.orderInDay}`;
const weeksIn = (startsOn: IsoDate, endsOn: IsoDate) => (daysBetween(startsOn, endsOn) + 1) / 7;
const datesOf = (startsOn: IsoDate, endsOn: IsoDate) => ({
	startsOn,
	endsOn,
	weeks: weeksIn(startsOn, endsOn)
});
const refuse = (refusal: ReplanRefusalReason, detail = ''): ReplanRefusal => ({
	refusal,
	why: detail ? `${REFUSALS[refusal]} ${detail}` : REFUSALS[refusal]
});
const goalsOf = (input: ProgrammingInput) =>
	input.maintenance
		? { goals: input.paused, refs: input.refs.paused }
		: { goals: input.goals, refs: input.refs.goals };
const focusOf = (d: ReplanDirective) =>
	d.kind === 'block' && d.focusGoalRef ? [d.focusGoalRef] : undefined;

/** A skeleton: `base` and what the mechanism sets, every other field empty. */
const skeletonOf = (
	base: Base,
	set: Pick<ReplanSkeleton, 'dates'> & Partial<ReplanSkeleton>
): ReplanSkeleton => ({
	before: [],
	cutAt: null,
	replaces: [],
	full: false,
	directives: null,
	outline: [],
	after: [],
	taper: null,
	decisions: [],
	previous: null,
	...base,
	...set
});

/** `block` up to the day before `at`. */
const cut = (block: BlockPlan, at: IsoDate): BlockPlan => ({
	...block,
	endsOn: addDays(at, -1),
	weeks: block.weeks.filter((w) => w.startsOn < at)
});

/**
 * The Monday a regenerating or splicing re-plan starts on (REPLAN_START): M3's next Monday (today
 * when today is a Monday), then the first Monday with nothing logged or skipped on or after it.
 */
export function replanStart(today: IsoDate, touched: readonly IsoDate[]): IsoDate {
	let start = mondayOf(today) === today ? today : addDays(mondayOf(today), 7);
	for (const date of [...touched].sort()) if (date >= start) start = addDays(mondayOf(date), 7);
	return start;
}

/** The current blocks before `at` (one across it cut), the one across it, and the indexes from it. */
function around(current: ProgramPlan, at: IsoDate) {
	const before = current.blocks.filter((b) => b.endsOn < at);
	const across = current.blocks.find((b) => b.startsOn < at && b.endsOn >= at) ?? null;
	if (across) before.push(cut(across, at));
	const replaces = current.blocks.flatMap((b, i) => (b.endsOn >= at ? [i] : []));
	return { before, replaces, across, cutAt: across ? at : null };
}

/** Why a block of `phase` over `span` works against a leading event: a conflict, or its taper. */
function conflictOf(input: ProgrammingInput, phase: Phase, span: ReplanSkeleton['dates']) {
	const emphasis = (BLOCK_PHASES.hypertrophy as readonly Phase[]).includes(phase)
		? 'hypertrophy'
		: ['accumulation', 'intensification', 'realization'].includes(phase)
			? 'strength'
			: null;
	for (let monday = span.startsOn; monday <= span.endsOn; monday = addDays(monday, 7)) {
		const leader = leaderOn(input, monday, { phase });
		if (!leader?.eventKind || !leader.eventDate || leader.eventDate < monday) continue;
		const pair = CONFLICTS.find(
			(c) => c.leader === leader.eventKind && c.against === emphasis && c.inWindow
		);
		const taper = taperWeeks(leader.eventKind, 'primary', leader.eventDate).weeks[0];
		if ((leader.inWindow && pair) || (taper && taper.startsOn <= span.endsOn))
			return `${leader.title} on ${leader.eventDate} leads then: ${pair ? pair.why : 'its taper falls inside the block.'}`;
	}
	return null;
}

/** The new block's directives: every exercise still eligible kept, none rotated (MECHANISMS). */
function directivesOf(
	input: ProgrammingInput,
	previous: BlockPlan | undefined,
	phase: Phase,
	weeks: number,
	season: SeasonPlan | null,
	past: number
): CycleDirectives {
	const keys = new Set<string>();
	for (const s of previous?.weeks.flatMap((w) => w.sessions) ?? [])
		if (s.kind === 'strength') for (const e of s.exercises) keys.add(toExerciseKey(e.exercise));
	const keep = [...keys].sort().flatMap((exercise) => {
		const found = exerciseOf(input, exercise as ReturnType<typeof toExerciseKey>);
		const reason = 'Kept: a re-plan never rotates exercises';
		return found && isEligible(found, input).ok ? [{ exercise, reason }] : [];
	});
	const first = season?.blocks[0];
	const chosen = season?.decisions.find(
		(d) => d.kind === 'block_type_chosen' && d.refs.includes(`blocks.${past}`)
	);
	const light = ['maintenance', 'recovery', 'taper', 'marathon_taper', 'half_taper'];
	return {
		fromBlockLineage: '',
		phase,
		weeks,
		fromOutline: false,
		keep,
		rotate: [],
		volume: [],
		rpe: DIRECTIVE_RULES.rpe.none,
		deload: first || light.includes(phase) || weeks < DELOAD_AFTER_WEEKS ? 'none' : 'last',
		running: input.running && {
			weeklyMetres: input.running.weeklyMetres,
			longRunMetres: input.running.longestRunMetres,
			paces: []
		},
		avoidDays: [],
		progression: 'progress',
		...(first && { weekPlan: first.weeks.map(({ kind, targets }) => ({ kind, targets })) }),
		...(chosen && { blockType: { ruleKey: chosen.ruleKey, facts: chosen.evidence as never } })
	};
}

/** `decisions` held to whole blocks from `first` on (the outline has no weeks); none left, dropped. */
const outlineDecisions = (decisions: readonly DecisionPlan[], first: number) =>
	decisions.flatMap((d) => {
		const blocks = d.refs.map((r) => /^blocks\.\d+/.exec(r)![0]);
		const refs = [...new Set(blocks.filter((r) => Number(r.slice(7)) >= first))];
		return refs.length ? [{ ...d, refs }] : [];
	});

function regenerate(
	input: ProgrammingInput,
	{ current, directive, from: at }: ReplanOptions,
	base: Base
): ReplanSkeleton | ReplanRefusal {
	const last = current.blocks.at(-1)!;
	if (at > last.endsOn) return refuse('nothing_ahead', `Your plan ends on ${last.endsOn}.`);
	const focus = focusOf(directive);
	if (focus && !goalsOf(input).refs.includes(focus[0]!))
		return refuse('not_applicable', 'That goal is not one you are training for.');
	if (at === current.startsOn && directive.kind === 'priorities') {
		const replaces = current.blocks.map((_, i) => i);
		return skeletonOf(base, { dates: datesOf(at, last.endsOn), replaces, full: true });
	}
	const { before, replaces, across, cutAt } = around(current, at);
	const previous = across ?? before.at(-1);
	const past = before.length;
	if (past + 1 > PLAN_BUDGET.blocks) return refuse('too_many_blocks');
	let [phase, weeks, season]: [Phase, number, SeasonPlan | null] = ['maintenance', 0, null];
	let road: SeasonPlan | { refusal: string };
	if (directive.kind === 'block') {
		[phase, weeks] = [directive.phase, directive.weeks];
		const conflict = conflictOf(input, phase, datesOf(at, addDays(at, 7 * weeks - 1)));
		if (conflict) return refuse('conflicts_with_event', conflict);
		const continuity = { phase, weeksDone: weeks };
		road = planSeason(input, addDays(at, 7 * weeks), { continuity, pastBlocks: past + 1 });
	} else {
		const continuity = previous && {
			phase: previous.phase,
			weeksDone: across ? weeksIn(across.startsOn, addDays(at, -1)) : 0
		};
		const planned = planSeason(input, at, { ...(continuity && { continuity }), pastBlocks: past });
		if (!('refusal' in planned)) {
			const first = planned.blocks[0]!;
			[phase, weeks, season] = [first.phase, weeksIn(first.startsOn, first.endsOn), planned];
		}
		road = 'refusal' in planned ? planned : { ...planned, blocks: planned.blocks.slice(1) };
	}
	if ('refusal' in road) return refuse('too_many_blocks');
	const dates = datesOf(at, addDays(at, 7 * weeks - 1));
	const outline = road.blocks.map((b) => ({ ...b, outline: true, weeks: [] }));
	const set = { before, replaces, cutAt, dates, previous: previous ?? null };
	if (previous?.outline) {
		// After an outline nothing is planned in detail: the new block is an outline too.
		const block: BlockSkeleton = {
			type: null,
			phase,
			name: PHASE_LABEL[phase],
			startsOn: dates.startsOn,
			endsOn: dates.endsOn,
			outline: true,
			goalRefs: focus ?? [...goalsOf(input).refs],
			weeks: [],
			event: null
		};
		const decisions = outlineDecisions(road.decisions, past);
		return skeletonOf(base, { ...set, outline: [block, ...outline], decisions });
	}
	return skeletonOf(base, {
		...set,
		directives: directivesOf(input, previous, phase, weeks, season, past),
		outline,
		decisions: outlineDecisions(road.decisions, past + 1)
	});
}

/**
 * The spliced taper's taper_planned decision, worded as the season words one: a later taper
 * directive for the same event finds it and is refused, so a taper is never applied twice.
 */
function taperPlanned(title: string, taper: TaperPlan, block: number): DecisionPlan {
	const { days } = taper;
	const steps = days ? [days.factor] : taper.weeks.map((t) => t.factor);
	return new DecisionLog().add('taper_planned', taper.ruleKey, [`blocks.${block}`], {
		event: clip(title, 60),
		date: taper.raceOn,
		length: days
			? plural(daysBetween(days.from, taper.raceOn), 'day')
			: plural(taper.weeks.length, 'week'),
		steps: `${steps.map((f) => Math.round(f * 100)).join(', ')} % of the volume`,
		reason: clip(days ? BY_PRIORITY.why : TAPERS[taper.event].why, 200)
	});
}

function splice(
	input: ProgrammingInput,
	{ current, directive, from: at }: ReplanOptions & { directive: Directive<'taper'> },
	base: Base
): ReplanSkeleton | ReplanRefusal {
	const { goals, refs } = goalsOf(input);
	const goal = goals[refs.indexOf(directive.goalRef)];
	const kind = goal && eventKindOf(goal);
	if (!goal?.eventDate || !kind || goal.eventDate < at)
		return refuse('not_applicable', 'Only an event still ahead can be tapered for.');
	const date = goal.eventDate;
	const taper = taperWeeks(kind, directive.form === 'full' ? 'primary' : 'secondary', date);
	const planned = current.decisions.some(
		(d) =>
			d.kind === 'taper_planned' &&
			d.evidence.date === date &&
			[taper.ruleKey, `taper.${kind}`].includes(d.ruleKey)
	);
	if (planned)
		return refuse('not_applicable', `${goal.title} on ${date} already has its taper planned.`);
	const first = taper.days?.from ?? taper.weeks[0]?.startsOn;
	if (!first || first < at) return refuse('too_close');
	const dates = datesOf(mondayOf(first), sundayOf(taper.days?.to ?? date));
	const last = current.blocks.at(-1)!;
	if (dates.endsOn > last.endsOn)
		return refuse('not_applicable', `Your plan ends on ${last.endsOn}, before ${goal.title}.`);
	const replaces = current.blocks.flatMap((b, i) =>
		b.endsOn >= dates.startsOn && b.startsOn <= dates.endsOn ? [i] : []
	);
	const inside = replaces.map((i) => current.blocks[i]!);
	if (taper.days ? inside.some((b) => b.outline) : new Set(inside.map((b) => b.outline)).size > 1)
		return refuse('not_applicable', 'Those weeks are not all planned in detail yet.');
	if (taper.days) {
		// A mini-taper changes its days' sessions in place: no block moves.
		const before = current.blocks.slice(0, replaces[0]);
		const after = current.blocks.slice(replaces.at(-1)! + 1);
		const decisions = [taperPlanned(goal.title, taper, before.length)];
		return skeletonOf(base, { dates, replaces, before, after, taper, decisions });
	}
	const { before, cutAt } = around(current, dates.startsOn);
	const next = addDays(dates.endsOn, 1);
	const after = current.blocks
		.filter((b) => b.endsOn >= next)
		.map((b) =>
			b.startsOn >= next
				? b
				: { ...b, startsOn: next, weeks: b.weeks.filter((w) => w.startsOn >= next) }
		);
	if (before.length + after.length + 1 > PLAN_BUDGET.blocks) return refuse('too_many_blocks');
	const decisions = [taperPlanned(goal.title, taper, before.length)];
	return skeletonOf(base, { dates, replaces, before, cutAt, after, taper, decisions });
}

function inPlace(
	input: ProgrammingInput,
	{ current, directive, today }: ReplanOptions & { directive: Directive<'deload'> },
	base: Base
): ReplanSkeleton | ReplanRefusal {
	const { week } = directive;
	if (addDays(week, 6) < today) return refuse('nothing_ahead');
	const ahead = addDays(mondayOf(today), 7 * DELOAD_HOLD.ownerWeeksAhead);
	if (directive.trigger !== 'reactive' && week > ahead)
		return refuse('not_applicable', 'Only this week or next can be deloaded.');
	const b = current.blocks.findIndex((x) => !x.outline && x.weeks.some((w) => w.startsOn === week));
	if (b < 0) return refuse('not_applicable', 'That week is not planned in detail yet.');
	const until = addDays(week, 7 * (DELOAD_HOLD.weeksAfter + 1) - 1);
	const light: readonly string[] = DELOAD_HOLD.kinds;
	const phases: readonly Phase[] = DELOAD_HOLD.phases;
	const within = (x: { startsOn: IsoDate }) => x.startsOn >= week && x.startsOn <= until;
	// An outline block has no weeks yet: a light-phase one (a taper, a recovery) is its light weeks.
	const held = [
		...current.blocks
			.flatMap((x) => x.weeks.filter((w) => light.includes(w.kind)))
			.map((w) => ({ startsOn: w.startsOn, what: `A ${w.kind} week` })),
		...current.blocks
			.filter((x) => x.outline && phases.includes(x.phase))
			.map((x) => ({ startsOn: x.startsOn, what: `A ${PHASE_LABEL[x.phase].toLowerCase()} block` }))
	].find(within);
	// Only an event its goal leads on gets a taper or an event week; one trained through gets none.
	const { goals, refs } = goalsOf(input);
	const event = goals.find(
		(g, i) =>
			g.eventDate &&
			within({ startsOn: g.eventDate }) &&
			leaderOn(input, mondayOf(g.eventDate))?.goalId === refs[i]
	);
	if (held || event) {
		const what = held
			? `${held.what} starts on ${held.startsOn}`
			: `${event!.title} is on ${event!.eventDate}`;
		return refuse('not_applicable', `${what}: ${DELOAD_HOLD.why}`);
	}
	const target = current.blocks[b]!.weeks.find((w) => w.startsOn === week)!;
	if (!target.sessions.some((s) => s.date >= today && !base.started.includes(sessionKey(s))))
		return refuse('nothing_ahead');
	return skeletonOf(base, {
		dates: datesOf(week, addDays(week, 6)),
		replaces: [b],
		before: current.blocks.slice(0, b),
		after: current.blocks.slice(b + 1)
	});
}

/**
 * What a re-plan changes and where, from today's profile input, or the refusal with its sentence.
 * The fingerprint is taken here, from the profile before any results overlay.
 */
export function replanSkeleton(
	input: ProgrammingInput,
	o: ReplanOptions
): ReplanSkeleton | ReplanRefusal {
	const { directive } = o;
	// A program that has not started yet is re-planned from its own start.
	const start = o.current.startsOn;
	const from = directive.kind === 'deload' ? directive.week : o.from < start ? start : o.from;
	if (mondayOf(from) !== from) throw new RangeError(`A re-plan starts on a Monday: ${from}`);
	const { baseVersionNumber, catalogueDigest = null } = o;
	const digest = fnv1a64(canonicalJson({ directive, baseVersionNumber, from, catalogueDigest }));
	const base: Base = {
		directive,
		mechanism: mechanismOf(directive.kind),
		from,
		today: o.today,
		current: o.current,
		fingerprint: fingerprint(input, digest, REPLAN_GENERATOR_ID),
		started: (o.started ?? []).map(sessionKey).sort()
	};
	if (directive.kind === 'taper') return splice(input, { ...o, from, directive }, base);
	if (directive.kind === 'deload') return inPlace(input, { ...o, directive }, base);
	return regenerate(input, { ...o, from }, base);
}

/** The replanned decision: who asked, from when, what changes and why. */
function replanned(s: ReplanSkeleton, refs: string[]): DecisionPlan {
	const d = s.directive;
	const who =
		d.kind === 'deload'
			? { reactive: 'Your weekly review', owner: 'You', coach: 'The coach' }[d.trigger]
			: d.kind !== 'priorities'
				? 'You'
				: d.cause === 'coach'
					? 'The coach'
					: 'Your goal change';
	const change = {
		priorities: 'the plan follows your goals’ new priorities',
		block:
			d.kind === 'block' &&
			`a ${PHASE_LABEL[d.phase].toLowerCase()} block of ${plural(d.weeks, 'week')}`,
		taper:
			d.kind === 'taper' &&
			`a ${d.form === 'full' ? 'full taper' : 'mini-taper'} before ${s.taper!.raceOn}`,
		deload: `the week of ${s.from} is a deload`
	}[d.kind] as string;
	const reasons = d.kind === 'deload' && d.reasons.length ? ` ${d.reasons.join('. ')}.` : '';
	return new DecisionLog().add('replanned', `replan.${s.mechanism}`, refs, {
		from: s.from,
		change: clip(change, 120),
		who,
		reason: clip(`${MECHANISMS[s.mechanism].why}${reasons}`, 200)
	});
}

/** The full taper's blocks: its weeks taperSessions of the current ones, kind taper. */
function taperBlock(s: ReplanSkeleton, goalRef: string): BlockPlan {
	const taper = s.taper!;
	const { startsOn, endsOn } = s.dates;
	const phase: Phase =
		taper.event === 'marathon' ? 'marathon_taper' : taper.event === 'half' ? 'half_taper' : 'taper';
	const replaced = s.replaces.map((i) => s.current.blocks[i]!);
	const current = replaced
		.flatMap((b) => b.weeks)
		.filter((w) => w.startsOn >= startsOn && w.startsOn <= endsOn);
	const weeks = taperSessions(current, taper).map((w) => {
		const factor = taper.weeks.find((t) => t.startsOn === w.startsOn)?.factor;
		if (factor === undefined) return w;
		const of = (n: number) => Math.round(n * factor * 100) / 100;
		const { volumeFactor, runVolumeFactor } = w.targets;
		const targets = {
			...w.targets,
			volumeFactor: of(volumeFactor),
			runVolumeFactor: of(runVolumeFactor)
		};
		return { ...w, kind: 'taper' as const, targets };
	});
	const outline = replaced[0]!.outline;
	return {
		phase,
		name: PHASE_LABEL[phase],
		startsOn,
		endsOn,
		outline,
		goalRefs: [goalRef],
		progression: {},
		weeks
	};
}

/**
 * The re-planned version from the skeleton. `input` is what a regenerated block is generated from
 * (the service's results overlay: loads from the latest e1RM, running from the actual mileage);
 * `previous` is what the block before `from` showed.
 */
export function generateReplan(
	input: ProgrammingInput,
	s: ReplanSkeleton,
	previous: ReplanPrevious
): Replan {
	const { current, directive, before, after } = s;
	let blocks: BlockPlan[];
	let made: DecisionPlan[] = s.decisions;
	let weeks: WeekPlan[] = [];
	if (s.full) {
		const options = { startsOn: s.from, firstPlannedDay: current.firstPlannedDay };
		({ blocks, decisions: made } = generateProgram(input, options));
	} else if (s.directives) {
		const firstPlannedDay = s.from > current.firstPlannedDay ? s.from : current.firstPlannedDay;
		const next = generateNextBlock(
			{ input, assumptions: [], subset: modifiableSubset(s.directives) },
			{
				dates: { block: { ...s.dates, outline: null }, shifted: [], lostWeeks: 0, firstPlannedDay },
				outline: null,
				previous: { ...previous, block: s.previous ?? current.blocks[0]! },
				directives: s.directives
			}
		);
		const focus = focusOf(directive);
		blocks = [
			...before,
			focus ? { ...next.block, goalRefs: focus } : next.block,
			...toBlockPlans(s.outline)
		];
		// generateNextBlock's refs name its block as blocks.0.
		const at = (r: string) => r.replace(/^blocks\.0(?=\.|$)/, `blocks.${before.length}`);
		made = [...next.decisions.map((d) => ({ ...d, refs: d.refs.map(at) })), ...made];
	} else if (s.mechanism === 'regenerate') {
		blocks = [...before, ...toBlockPlans(s.outline)];
	} else if (s.taper?.days) {
		const changed = s.replaces.map((i) => {
			const b = current.blocks[i]!;
			return { ...b, weeks: taperSessions(b.weeks, s.taper!) };
		});
		blocks = [...before, ...changed, ...after];
		weeks = changed
			.flatMap((b) => b.weeks)
			.filter((w) => w.startsOn >= s.dates.startsOn && w.startsOn <= s.dates.endsOn);
	} else if (s.taper) {
		const block = taperBlock(s, directive.kind === 'taper' ? directive.goalRef : '');
		[blocks, weeks] = [[...before, block, ...after], block.weeks];
	} else {
		const block = current.blocks[s.replaces[0]!]!;
		const started = new Set(s.started);
		const ahead = (x: { date: IsoDate; orderInDay: number }) =>
			x.date >= s.today && !started.has(sessionKey(x));
		const week = block.weeks.find((w) => w.startsOn === s.from)!;
		const targets = deloadWeek(week.targets, TARGETS, week.kind);
		const sessions = deloadSessions(week, TARGETS, ahead, previous.sessions);
		const deload: WeekPlan = { ...week, kind: 'deload', targets, sessions };
		blocks = [
			...before,
			{ ...block, weeks: block.weeks.map((w) => (w === week ? deload : w)) },
			...after
		];
		weeks = [deload];
	}
	const decisions = [replanned(s, [`blocks.${s.full ? 0 : before.length}`]), ...made];
	const checked = validate(programPlanSchema, {
		title: current.title,
		startsOn: s.full ? s.from : current.startsOn,
		firstPlannedDay: current.firstPlannedDay,
		blocks,
		decisions
	});
	if (!checked.ok) throw new GeneratedPlanError(checked.errors);
	const plan = checked.data;
	return {
		plan,
		outline: plan.blocks.filter((b) => b.outline),
		weeks,
		decisions: plan.decisions,
		fingerprint: s.fingerprint,
		shapeDigest: shapeDigest(plan, s.from)
	};
}
