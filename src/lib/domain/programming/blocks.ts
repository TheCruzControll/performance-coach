/**
 * The first block and the road after it (PRD §5; m3-plan 'Several dated events'): dated blocks
 * and weeks, each week with its targets, by the numbers in rules/blocks.ts. The stages after this
 * one fill the weeks with sessions.
 *
 * - The highest-priority dated goal shapes the first block. An event under SHORT_EVENT_WEEKS
 *   away gets a block that builds straight to it from the baseline week and tapers; a dated half
 *   or full marathon makes it a marathon base. Otherwise it is FIRST_BLOCK.
 * - Another event inside the first block turns the week before it into a taper (event_taper).
 * - The outline leads, phase by phase, to the highest-priority event after the first block and
 *   ends on that event's Sunday. Its blocks are dated and hold no weeks until M6 plans them. Any
 *   other event after the first block is noted on the outline block it falls in.
 * - Each 'not told yet' default becomes a default_assumed decision and each paused goal a
 *   goal_excluded one. When every goal is paused, the all_goals_paused default says so instead.
 */
import { addDays, daysBetween, mondayOf } from '../calendar.ts';
import type { IsoDate } from '../calendar.ts';
import type { BlockPlan, WeekPlan } from '../training/types.ts';
import { PHASE_LABEL, WEEK_KIND_LABEL } from '../training/vocabulary.ts';
import type { Phase, WeekKind } from '../training/vocabulary.ts';
import type { DecisionLog } from './decisions.ts';
import { clip } from './demand.ts';
import { weeksToEvent } from './input.ts';
import type { InputGoal, ProgrammingInput } from './input.ts';
import {
	FIRST_BLOCK,
	OUTLINES,
	SHORT_EVENT_WEEKS,
	TAPER_LEAD_DAYS,
	weekTargets
} from './rules/blocks.ts';
import { assumptionFacts } from './rules/defaults.ts';

interface DatedEvent {
	goal: InputGoal;
	ref: string;
	date: IsoDate;
	/** The week holding it, from 0. */
	week: number;
}

const named = (e: DatedEvent) => clip(e.goal.title, 60);
const lower = (kind: WeekKind) => WEEK_KIND_LABEL[kind].toLowerCase().replace(/ week$/, '');

/** Runs of one week kind in words: 'baseline week, 3 accumulation weeks, deload week'. */
function structureOf(kinds: readonly WeekKind[]): string {
	const runs: [WeekKind, number][] = [];
	for (const kind of kinds) {
		const last = runs.at(-1);
		if (last?.[0] === kind) last[1] += 1;
		else runs.push([kind, 1]);
	}
	return runs.map(([k, n]) => (n > 1 ? `${n} ${lower(k)} weeks` : `${lower(k)} week`)).join(', ');
}

/** The outline's blocks from `from`, a Monday, to the Sunday of `target`'s week. */
function outlineTo(target: DatedEvent, from: IsoDate, baseDone: boolean): BlockPlan[] {
	const marathon = target.goal.disciplines.includes('distance_running');
	const half = /half/i.test(target.goal.eventType ?? target.goal.title);
	const phases = OUTLINES[!marathon ? 'event' : half ? 'half' : 'marathon'].filter(
		([phase]) => !(baseDone && phase === 'marathon_base')
	);
	let left = daysBetween(from, mondayOf(target.date)) / 7 + 1;
	const weeks = phases.map(() => 0);
	for (let i = phases.length - 1; i >= 0; i--) {
		const fixed = phases[i]![1];
		if (fixed !== null) left -= weeks[i] = Math.min(fixed, left);
	}
	weeks[phases.findIndex(([, n]) => n === null)] = left;
	let startsOn = from;
	return phases.flatMap(([phase], i) => {
		if (!weeks[i]) return [];
		const endsOn = addDays(startsOn, 7 * weeks[i]! - 1);
		const block = { phase, name: PHASE_LABEL[phase], startsOn, endsOn, outline: true };
		startsOn = addDays(endsOn, 1);
		return [{ ...block, goalRefs: [target.ref], progression: {}, weeks: [] }];
	});
}

/** The first block, then the outline: `startsOn` is the Monday of week 1. */
export function planFirstBlock(
	input: ProgrammingInput,
	startsOn: IsoDate,
	log: DecisionLog
): BlockPlan[] {
	const goals = input.maintenance ? input.paused : input.goals;
	const refs = input.maintenance ? input.refs.paused : input.refs.goals;
	const events = goals.flatMap((goal, i): DatedEvent[] => {
		const week = weeksToEvent(goal, startsOn);
		return week !== null && week >= 0 ? [{ goal, ref: refs[i]!, date: goal.eventDate!, week }] : [];
	});
	const taperOf = (e: DatedEvent) =>
		Math.floor(daysBetween(startsOn, addDays(e.date, -TAPER_LEAD_DAYS)) / 7);

	const lead = events[0];
	const shape = !lead
		? 'default'
		: lead.week < SHORT_EVENT_WEEKS
			? 'short_event'
			: lead.goal.disciplines.includes('distance_running')
				? 'marathon'
				: 'event';
	const taper = lead ? taperOf(lead) : -1;
	const kinds: WeekKind[] =
		shape === 'short_event'
			? Array.from({ length: lead!.week + 1 }, (_, i) =>
					i === 0 ? 'baseline' : i < taper ? 'build' : i === taper ? 'taper' : 'event'
				)
			: [...FIRST_BLOCK];
	// An event inside the block tapers the week before it; the baseline week stays as it is.
	const tapers = events.flatMap((e) => {
		const week = taperOf(e);
		if (e.week >= kinds.length || week < 1) return [];
		kinds[week] = 'taper';
		return [{ e, week }];
	});

	const phase: Phase =
		shape === 'short_event'
			? 'realization'
			: shape === 'marathon'
				? 'marathon_base'
				: input.maintenance
					? 'maintenance'
					: input.disciplines[0] === 'hypertrophy'
						? 'hypertrophy'
						: 'accumulation';
	let step = 0;
	const weeks = kinds.map((kind, i): WeekPlan => {
		const weekStart = addDays(startsOn, 7 * i);
		const targets = weekTargets(kind, step);
		if (kind === 'accumulation' || kind === 'build') step += 1;
		return { kind, startsOn: weekStart, endsOn: addDays(weekStart, 6), targets, sessions: [] };
	});
	const first: BlockPlan = {
		phase,
		name: shape === 'short_event' ? clip(`Build to ${lead!.goal.title}`, 60) : PHASE_LABEL[phase],
		startsOn,
		endsOn: addDays(startsOn, 7 * kinds.length - 1),
		outline: false,
		goalRefs: [...refs],
		progression: {},
		weeks
	};

	const after = addDays(first.endsOn, 1);
	const target = events.find((e) => e.date >= after);
	const outline = target ? outlineTo(target, after, phase === 'marathon_base') : [];
	const notes = events
		.filter((e) => e !== target && e.date >= after)
		.map((e) => {
			const block = outline.find((b) => b.endsOn >= e.date);
			block?.goalRefs.push(e.ref);
			const where = block
				? `falls in its ${block.name.toLowerCase()}, so it is noted there`
				: 'comes after it, so it is planned later';
			return ` ${named(e)} on ${e.date} ${where}.`;
		});

	const about = lead && `${named(lead)} on ${lead.date}`;
	const reasons = {
		default:
			'With no event date ahead, it is the standard start: a baseline week, three weeks that build on it and a deload that absorbs them.',
		short_event: `${about} is under ${SHORT_EVENT_WEEKS} weeks away, so the block builds straight to it from the baseline week and tapers before it.`,
		marathon: `${about} is your top dated goal, so the block builds your running base first.`,
		event: `${about} is your top dated goal, so the block builds the base that the outline leads on from.`
	};
	log.add('block_structure', `blocks.${shape}`, ['blocks.0'], {
		block: 'First block',
		structure: structureOf(kinds),
		weeks: kinds.length,
		reason: reasons[shape],
		notes: ''
	});
	for (const { e, week } of tapers) {
		log.add('event_taper', 'blocks.event_taper', [`blocks.0.weeks.${week}`], {
			event: named(e),
			date: e.date
		});
	}
	if (target) {
		log.add('block_structure', 'blocks.outline', ['blocks.1'], {
			block: `Outline to ${named(target)}`,
			structure: outline
				.map((b) => `${b.name.toLowerCase()} ${(daysBetween(b.startsOn, b.endsOn) + 1) / 7} weeks`)
				.join(', '),
			weeks: (daysBetween(after, outline.at(-1)!.endsOn) + 1) / 7,
			reason: `It ends with ${named(target)} on ${target.date}, and each phase is planned in full when it comes up.`,
			notes: clip(notes.join(''), 200)
		});
	}
	for (const assumption of input.assumptions) {
		log.add('default_assumed', assumption.ruleKey, [], assumptionFacts(assumption, input));
	}
	if (!input.maintenance) {
		for (const goal of input.paused) {
			log.add('goal_excluded', 'goals.paused', [], { goal: clip(goal.title, 80) });
		}
	}
	return [first, ...outline];
}
