/**
 * The season as windows (m7-plan season-windows; PRD §2 and §5), from rules/season.ts: who leads
 * each stretch from `from` to `horizonEnd`, in whole Monday-to-Sunday weeks.
 * - event: an event's run-up, led by its goal; where windows overlap, the higher-ranked event
 *   keeps its weeks and the other is held (or mini-tapers) through the overlap
 * - recovery: the easy weeks after a fight or a marathon
 * - fill: the weeks between, led by the leading undated goal
 * - maintenance: every goal at its dose, none leading: the whole season when every goal is
 *   paused (M3's case), a short gap after a recovery, and wherever no goal wants a building block
 * Each window carries every goal's mode and every held goal's dose, with the facts for its
 * priority_resolved, block_type_chosen and maintenance_dose decisions. It reads M3's shaping goals
 * through effectivePriorities. Pure and deterministic.
 */
import { addDays, daysBetween, mondayOf } from '../../calendar.ts';
import type { IsoDate } from '../../calendar.ts';
import type { Phase } from '../../training/vocabulary.ts';
import type { FactsFor } from '../decisions.ts';
import { clip } from '../demand.ts';
import type { GoalMode } from '../evaluate/types.ts';
import type { InputGoal, ProgrammingInput } from '../input.ts';
import { dosesFor, holdEveryGoal, maintenanceDoses } from '../priority/doses.ts';
import type { GoalDose } from '../priority/doses.ts';
import { effectivePriorities, eventKindOf, priorityFacts } from '../priority/weights.ts';
import type { GoalPriority } from '../priority/weights.ts';
import { compareText } from '../random.ts';
import type { EventKind } from '../rules/priority.ts';
import {
	FILL,
	LEAD_IN,
	MAINTENANCE,
	OVERLAP,
	RECOVERY,
	taperOnlyUnder,
	WINDOW
} from '../rules/season.ts';
import type { BlockType } from './kinds.ts';
import { taperWeeks } from './taper.ts';
import type { TaperPlan } from './taper.ts';

/** The rule keys a window cites: each is registered in rules/registry/season.ts. */
export const SEASON_RULE_KEYS = {
	window: 'season.window',
	overlap: 'season.overlap',
	recovery: 'season.recovery',
	fill: 'season.fill',
	leadIn: 'season.lead_in',
	paused: 'season.maintenance.paused',
	shortGap: 'season.maintenance.short_gap',
	noBuildingGoal: 'season.maintenance.no_building_goal'
} as const;
export type SeasonRuleKey = (typeof SEASON_RULE_KEYS)[keyof typeof SEASON_RULE_KEYS];

export type WindowKind = 'event' | 'recovery' | 'fill' | 'maintenance';

/** A goal's mode through a window, and why. */
export interface WindowMode {
	goalId: string;
	title: string;
	mode: GoalMode;
	why: string;
}

/** A lower-ranked event's goal inside a higher-ranked window, over the weeks they overlap. */
export interface WindowOverlap {
	goalId: string;
	title: string;
	from: IsoDate;
	to: IsoDate;
	/** Held at maintenance; its event inside gets a mini-taper, or is trained through. */
	form: 'maintenance' | 'mini_taper' | 'train_through';
	/** The mini-taper; null otherwise. */
	taper: TaperPlan | null;
	/** Its doses while held; none for a mini-taper or a recovery. */
	doses: GoalDose[];
	why: string;
	ruleKey: typeof SEASON_RULE_KEYS.overlap;
}

export interface SeasonWindow {
	kind: WindowKind;
	/** A Monday. */
	from: IsoDate;
	/** A Sunday. */
	to: IsoDate;
	weeks: number;
	/** The goals the window holds, the leader first; M3's refs.paused when every goal is paused. */
	goalRefs: string[];
	/** The event an event window runs up to, or a recovery window follows. */
	event: { goalId: string; title: string; kind: EventKind; date: IsoDate } | null;
	/** The M7 block type; null plans M3's own phase (an event outline, or accumulation). */
	blockType: BlockType | null;
	phases: Phase[];
	leader: { goalId: string; title: string } | null;
	modes: WindowMode[];
	/** Every goal held at maintenance, at its dose. */
	doses: GoalDose[];
	overlaps: WindowOverlap[];
	ruleKey: SeasonRuleKey;
	/** Why the window is what it is, naming the goals and dates. */
	why: string;
	facts: {
		priority: { ruleKey: string; facts: FactsFor<'priority_resolved'> } | null;
		block: { ruleKey: SeasonRuleKey; facts: FactsFor<'block_type_chosen'> };
		doses: { ruleKey: string; facts: FactsFor<'maintenance_dose'> }[];
	};
}

interface Event {
	goal: InputGoal;
	id: string;
	kind: EventKind;
	date: IsoDate;
}

type Slot = { owner: number; role: 'event' | 'recovery' } | null;

interface Run {
	lo: number;
	hi: number;
	slot: Slot;
	/** The season's first weeks joined this run-up (LEAD_IN). */
	leadIn?: true;
}

const TYPE_WORDS: Record<BlockType, string> = {
	strength: 'strength',
	hypertrophy: 'muscle-building',
	marathon: 'marathon',
	half: 'half marathon',
	fight_camp: 'fight camp',
	recovery: 'recovery',
	maintenance: 'maintenance'
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** `input` with goal `id` ranked first, so effectivePriorities makes it the leader. */
function ledBy(input: ProgrammingInput, id: string): ProgrammingInput {
	const goals = input.goals.map((g, i) => (input.refs.goals[i] === id ? { ...g, priority: 0 } : g));
	return { ...input, goals };
}

/**
 * The priorities through a window led by goal `id` from `on`: effectivePriorities' own when it
 * already leads, otherwise with `id` ranked first and its leader sentence `why`.
 */
function prioritiesLedBy(
	input: ProgrammingInput,
	id: string,
	on: IsoDate,
	phases: readonly Phase[],
	why: string
): GoalPriority[] {
	// A single-phase window knows its phase; a longer one is judged by its lead window.
	const options = phases.length === 1 ? { phase: phases[0]! } : {};
	const natural = effectivePriorities(input, on, options);
	if (natural[0]?.goalId === id && natural[0].mode === 'primary') return natural;
	const own = input.goals[input.refs.goals.indexOf(id)]!;
	return effectivePriorities(ledBy(input, id), on, options).map((p) =>
		p.goalId === id ? { ...p, priority: own.priority, why } : p
	);
}

const modesOf = (priorities: readonly GoalPriority[]): WindowMode[] =>
	priorities.map(({ goalId, title, mode, why }) => ({ goalId, title, mode, why }));

const doseFacts = (doses: readonly GoalDose[]) =>
	doses.map((d) => ({
		ruleKey: `maintenance.${d.stream}` as const,
		facts: {
			goal: clip(d.goal.title, 60),
			leader: d.leader ? clip(d.leader.title, 60) : 'no other goal',
			dose: clip(d.dose.words, 200),
			reason: clip(d.reason, 200)
		}
	}));

/** The season's windows from `from`'s Monday to the Sunday of `horizonEnd`'s week, in order. */
export function seasonWindows(
	input: ProgrammingInput,
	from: IsoDate,
	horizonEnd: IsoDate
): SeasonWindow[] {
	const start = mondayOf(from);
	const count = Math.floor(daysBetween(start, horizonEnd) / 7) + 1;
	if (count < 1) return [];
	const weekOf = (date: IsoDate) => Math.floor(daysBetween(start, date) / 7);
	const monday = (week: number) => addDays(start, 7 * week);
	const sunday = (week: number) => addDays(start, 7 * week + 6);

	const window = (
		lo: number,
		hi: number,
		w: Omit<SeasonWindow, 'from' | 'to' | 'weeks' | 'facts' | 'overlaps'> & {
			priorities: readonly GoalPriority[];
			name: string;
		}
	): SeasonWindow => {
		const { priorities, name, ...rest } = w;
		const weeks = hi - lo + 1;
		const priority = priorityFacts(priorities, monday(lo), sunday(hi));
		return {
			...rest,
			from: monday(lo),
			to: sunday(hi),
			weeks,
			overlaps: [],
			facts: {
				priority: priority && {
					ruleKey: rest.kind === 'fill' ? rest.ruleKey : priority.ruleKey,
					facts: priority.facts
				},
				block: {
					ruleKey: rest.ruleKey,
					facts: {
						block: clip(name, 60),
						type: rest.blockType ? TYPE_WORDS[rest.blockType] : 'building',
						weeks,
						startsOn: monday(lo),
						reason: clip(rest.why, 200)
					}
				},
				doses: doseFacts(rest.doses)
			}
		};
	};

	const maintenanceWindow = (lo: number, hi: number, ruleKey: SeasonRuleKey, why: string) => {
		const held = holdEveryGoal(effectivePriorities(input, monday(lo), { phase: 'maintenance' }));
		return window(lo, hi, {
			kind: 'maintenance',
			goalRefs: input.maintenance ? [...input.refs.paused] : held.map((p) => p.goalId),
			event: null,
			blockType: 'maintenance',
			phases: ['maintenance'],
			leader: null,
			modes: modesOf(held),
			doses: maintenanceDoses(input, monday(lo)),
			ruleKey,
			why,
			priorities: [],
			name: 'Maintenance'
		});
	};

	// Every open goal paused: one maintenance block over them all, as M3 plans it.
	if (input.maintenance) {
		return [maintenanceWindow(0, count - 1, SEASON_RULE_KEYS.paused, MAINTENANCE.paused.why)];
	}

	const goals = input.goals.map((goal, i) => ({ goal, id: input.refs.goals[i]! }));
	const events: Event[] = goals
		.flatMap(({ goal, id }) => {
			const kind = eventKindOf(goal);
			// An event before the start week is kept while its recovery reaches week 0.
			return kind && weekOf(goal.eventDate!) + RECOVERY.weeks[kind] >= 0
				? [{ goal, id, kind, date: goal.eventDate! }]
				: [];
		})
		.sort(
			(a, b) =>
				a.goal.priority - b.goal.priority || compareText(a.date, b.date) || compareText(a.id, b.id)
		);

	// Each event claims its free weeks in rank order, then its recovery; a clash is an overlap.
	const slots: Slot[] = Array.from({ length: count }, () => null);
	const clashes: { owner: number; week: number }[] = [];
	events.forEach((e, owner) => {
		const at = weekOf(e.date);
		for (
			let week = Math.max(0, at - WINDOW.weeks[e.kind] + 1);
			week <= Math.min(at, count - 1);
			week++
		) {
			if (slots[week]) clashes.push({ owner, week });
			else slots[week] = { owner, role: 'event' };
		}
		if (at >= 0 && slots[at]?.owner !== owner) return;
		for (
			let week = Math.max(0, at + 1);
			week <= Math.min(at + RECOVERY.weeks[e.kind], count - 1);
			week++
		) {
			slots[week] ??= { owner, role: 'recovery' };
		}
	});

	const runs: Run[] = [];
	slots.forEach((slot, week) => {
		const last = runs.at(-1);
		if (last && last.slot?.owner === slot?.owner && last.slot?.role === slot?.role) last.hi = week;
		else runs.push({ lo: week, hi: week, slot });
	});
	// A short lead-in joins the first window when its event already leads on the first day.
	const [first, next] = runs;
	if (
		first &&
		next?.slot?.role === 'event' &&
		!first.slot &&
		first.hi - first.lo + 1 < LEAD_IN.weeks &&
		effectivePriorities(input, start)[0]?.goalId === events[next.slot.owner]!.id
	) {
		next.lo = first.lo;
		next.leadIn = true;
		runs.shift();
	}

	const building = goals
		.filter(({ goal }) => goal.eventDate === null && !isKeepGoal(goal))
		.sort((a, b) => a.goal.priority - b.goal.priority || compareText(a.id, b.id))[0];

	const windows = runs.map((run, i): SeasonWindow => {
		const { lo, hi, slot, leadIn } = run;
		if (!slot) {
			// Only a gap a later run-up closes: the horizon's end is not a run-up.
			const closed = runs[i - 1]?.slot?.role === 'recovery' && runs[i + 1] !== undefined;
			if (closed && hi - lo + 1 < MAINTENANCE.shortGap.weeks) {
				return maintenanceWindow(lo, hi, SEASON_RULE_KEYS.shortGap, MAINTENANCE.shortGap.why);
			}
			if (!building) {
				return maintenanceWindow(
					lo,
					hi,
					SEASON_RULE_KEYS.noBuildingGoal,
					MAINTENANCE.noBuildingGoal.why
				);
			}
			return fillWindow(lo, hi, building.goal, building.id);
		}
		const e = events[slot.owner]!;
		const event = { goalId: e.id, title: e.goal.title, kind: e.kind, date: e.date };
		if (slot.role === 'recovery') {
			const priorities = effectivePriorities(input, monday(lo), { phase: 'recovery' });
			const why = `Easy weeks after ${e.goal.title} on ${e.date}: ${plural(RECOVERY.weeks[e.kind], 'recovery week')} before anything builds again.`;
			return window(lo, hi, {
				kind: 'recovery',
				goalRefs: priorities.map((p) => p.goalId),
				event,
				blockType: 'recovery',
				phases: ['recovery'],
				leader: null,
				modes: modesOf(priorities).map((m) => ({ ...m, mode: 'maintenance', why })),
				doses: [],
				ruleKey: SEASON_RULE_KEYS.recovery,
				why,
				priorities: [],
				name: 'Recovery'
			});
		}
		const holdsEvent = weekOf(e.date) <= hi;
		const full = WINDOW.phases[e.kind];
		const taper = WINDOW.taperPhase[e.kind];
		const taperOnly = holdsEvent && hi - lo + 1 < taperOnlyUnder(e.kind);
		const phases: Phase[] = taperOnly
			? [taper]
			: holdsEvent
				? [...full]
				: full.filter((p) => p !== taper);
		const why = taperOnly
			? `${e.goal.title} on ${e.date} is under ${plural(taperOnlyUnder(e.kind), 'week')} away, so only its taper is planned.`
			: leadIn
				? `${e.goal.title} on ${e.date} leads its ${plural(hi - lo + 1, 'week')} run-up from the first day: ${LEAD_IN.why}`
				: `${e.goal.title} on ${e.date} leads its ${plural(hi - lo + 1, 'week')} run-up: ${WINDOW.weeks[e.kind]} weeks is its window.`;
		const priorities = prioritiesLedBy(
			input,
			e.id,
			monday(lo),
			phases,
			`${e.goal.title} on ${e.date} leads these weeks of its run-up, the higher-ranked events having claimed theirs.`
		);
		return window(lo, hi, {
			kind: 'event',
			goalRefs: priorities.map((p) => p.goalId),
			event,
			blockType: WINDOW.blockType[e.kind],
			phases,
			leader: { goalId: e.id, title: e.goal.title },
			modes: modesOf(priorities),
			doses: dosesFor(priorities, input),
			ruleKey: leadIn ? SEASON_RULE_KEYS.leadIn : SEASON_RULE_KEYS.window,
			why,
			priorities,
			name: clip(`Run-up to ${e.goal.title}`, 60)
		});
	});

	function fillWindow(lo: number, hi: number, goal: InputGoal, id: string): SeasonWindow {
		const type = FILL.blockType[goal.disciplines[0] as keyof typeof FILL.blockType] ?? null;
		const phases: Phase[] = [...FILL.phases[type ?? 'none']];
		const why = `${goal.title} leads from ${monday(lo)}: no event is inside its lead window, and it is your top-ranked goal without an event date.`;
		const priorities = prioritiesLedBy(input, id, monday(lo), phases, why);
		return window(lo, hi, {
			kind: 'fill',
			goalRefs: priorities.map((p) => p.goalId),
			event: null,
			blockType: type,
			phases,
			leader: { goalId: id, title: goal.title },
			modes: modesOf(priorities),
			doses: dosesFor(priorities, input),
			ruleKey: SEASON_RULE_KEYS.fill,
			why,
			priorities,
			name: `${goal.title}: ${phases.length === 1 ? phases[0] : 'building'}`
		});
	}

	// Each clash: the lower-ranked goal held, or mini-tapering, inside the window that owns the week.
	const runOf = (week: number) => runs.findIndex((r) => r.lo <= week && week <= r.hi);
	const spans = new Map<string, { owner: number; run: number; lo: number; hi: number }>();
	for (const { owner, week } of clashes) {
		const key = `${owner}:${runOf(week)}`;
		const span = spans.get(key);
		if (span) span.hi = week;
		else spans.set(key, { owner, run: runOf(week), lo: week, hi: week });
	}
	for (const { owner, run, lo, hi } of spans.values()) {
		const e = events[owner]!;
		const host = windows[run]!;
		const inside = weekOf(e.date) >= lo && weekOf(e.date) <= hi;
		const base = { goalId: e.id, title: e.goal.title, from: monday(lo), to: sunday(hi) };
		const ruleKey = SEASON_RULE_KEYS.overlap;
		if (inside) {
			// Its mode in the host: a goal held at maintenance there trains through (BY_PRIORITY).
			const mode = host.modes.find((m) => m.goalId === e.id)?.mode ?? 'maintenance';
			const mini = taperWeeks(e.kind, mode === 'maintenance' ? 'maintenance' : 'secondary', e.date);
			const hostTaper =
				host.kind === 'event' && host.event
					? [
							...taperWeeks(host.event.kind, 'primary', host.event.date).weeks.map((w) =>
								weekOf(w.startsOn)
							),
							weekOf(host.event.date)
						]
					: [];
			const clash =
				host.kind !== 'event' ||
				!mini.days ||
				[weekOf(mini.days.from), weekOf(mini.days.to)].some((w) => hostTaper.includes(w));
			host.overlaps.push({
				...base,
				form: clash ? 'train_through' : 'mini_taper',
				taper: clash ? null : mini,
				doses: [],
				why:
					!mini.days && host.leader
						? `${e.goal.title} on ${e.date} is held at maintenance inside ${host.leader.title}’s run-up, so it is trained through as a hard training day.`
						: clash
							? `${e.goal.title} on ${e.date} falls in ${host.leader?.title ?? 'a recovery'}’s ${host.kind === 'event' ? 'taper' : 'weeks'}, so it is trained through: never two tapers in one week.`
							: `${e.goal.title} on ${e.date} falls inside ${host.leader!.title}’s run-up, which you rank higher, so it gets ${OVERLAP.eventInside.days} easier days before it.`,
				ruleKey
			});
			continue;
		}
		const held = host.leader
			? `${e.goal.title} is held at maintenance from ${base.from} to ${base.to}, inside ${host.leader.title}’s run-up, which you rank higher.`
			: `${e.goal.title} is held through ${base.from} to ${base.to} while you recover.`;
		const goal = effectivePriorities(input, base.from).find((p) => p.goalId === e.id)!;
		host.overlaps.push({
			...base,
			form: OVERLAP.held,
			taper: null,
			doses: host.leader
				? dosesFor([{ ...goal, mode: 'maintenance', why: held }], input).map((d) => ({
						...d,
						leader: { id: host.leader!.goalId, title: host.leader!.title }
					}))
				: [],
			why: held,
			ruleKey
		});
	}
	return windows;
}

/** A goal that only keeps what it has: it never wants a building block (rules/season.ts FILL). */
export const isKeepGoal = (goal: Pick<InputGoal, 'title' | 'focus'>) =>
	FILL.keep.test(goal.title) || (goal.focus !== null && FILL.keep.test(goal.focus));
