/**
 * What runs before the stages, in M3's generator and M6's next block alike (m7-plan
 * generator-season): it plans the season and hands the stages an input that follows it.
 * - The season: planSeason from week 1's Monday, and its doses, into Draft.periodisation. When
 *   every goal is paused (input.maintenance), the season is the one maintenance block over
 *   input.paused that M3 plans.
 * - The priorities: each shaping goal's effective priority in every week of the first block, at
 *   that block's phase (a maintenance block holds every goal at its dose), a secondary goal the
 *   season doses that week held at maintenance; the goal that leads a week is never dosed.
 * - The input the stages read: input.goals, their refs and the disciplines reordered by effective
 *   priority on week 1's Monday, the leader first, so M3's allocation, split choice and placement
 *   follow the leader; and input.modes, each goal's mode then, so a secondary strength goal keeps
 *   its own split (chooseSplit). With every goal paused the order stays M3's.
 * - A priority_resolved decision for each run of weeks one goal leads by one rule, citing the first
 *   block, with the leader's ref and mode in its evidence.
 * With no shaping goal, or a season the plan budget refuses, it is the identity with no
 * periodisation, and M3's stages plan as they always did. The title and the stored input snapshot
 * always keep the original input. Pure and deterministic.
 */
import { addDays, daysBetween } from '../../calendar.ts';
import type { IsoDate } from '../../calendar.ts';
import type { Phase } from '../../training/vocabulary.ts';
import type { DecisionLog } from '../decisions.ts';
import type { ProgrammingInput } from '../input.ts';
import { planSeason } from '../periodisation/season.ts';
import type { SeasonPlan } from '../periodisation/season.ts';
import { holdEveryGoal } from '../priority/doses.ts';
import { effectivePriorities, priorityFacts } from '../priority/weights.ts';
import type { GoalPriority } from '../priority/weights.ts';
import type { GenerateOptions, Periodisation } from '../stage.ts';

export interface Prepared {
	/** The input the stages read. */
	input: ProgrammingInput;
	/** The draft's periodisation; null while none is planned. */
	periodisation: Periodisation | null;
}

/** `season` as every-goal-paused plans it: its first block alone, as M3's plan has one. */
function firstBlockOnly(season: SeasonPlan): SeasonPlan {
	const inFirst = (refs: readonly string[]) => refs.every((r) => r.startsWith('blocks.0'));
	return {
		...season,
		blocks: season.blocks.slice(0, 1),
		decisions: season.decisions.filter((d) => inFirst(d.refs))
	};
}

/** `input` with its goals, their refs and its disciplines in `priorities`' order. */
function reordered(input: ProgrammingInput, priorities: readonly GoalPriority[]): ProgrammingInput {
	const at = priorities.map((p) => input.refs.goals.indexOf(p.goalId));
	const goals = at.map((i) => input.goals[i]!);
	const rank = (d: string) => goals.findIndex((g) => g.disciplines.some((x) => x === d));
	return {
		...input,
		goals,
		disciplines: [...input.disciplines].sort((a, b) => rank(a) - rank(b)),
		refs: { ...input.refs, goals: at.map((i) => input.refs.goals[i]!) }
	};
}

type Week = Periodisation['prioritiesByWeek'][number];
const leaderOf = (week: Week) => week.priorities.find((p) => p.mode === 'primary');

/**
 * One priority_resolved decision per run of weeks led by the same goal under the same rule, the
 * last run lasting to the block's end. None while no goal leads (every goal paused).
 */
function recordPriorities(byWeek: readonly Week[], endsOn: IsoDate, log: DecisionLog) {
	const runs: { first: Week; until: IsoDate }[] = [];
	for (const week of byWeek) {
		const [last, leader] = [runs.at(-1), leaderOf(week)];
		const before = last && leaderOf(last.first);
		if (last && before?.goalId === leader?.goalId && before?.rule === leader?.rule) {
			last.until = addDays(week.startsOn, 6);
		} else runs.push({ first: week, until: addDays(week.startsOn, 6) });
	}
	for (const [i, { first, until }] of runs.entries()) {
		const to = i === runs.length - 1 && endsOn > until ? endsOn : until;
		const resolved = priorityFacts(first.priorities, first.startsOn, to);
		const leader = leaderOf(first);
		if (!resolved || !leader) continue;
		log.add('priority_resolved', resolved.ruleKey, ['blocks.0'], {
			...resolved.facts,
			goalRef: leader.goalId,
			mode: leader.mode
		});
	}
}

/** The block a next block plans (M6's nextShape): its phase and last day, from week 1's Monday. */
export interface PlannedBlock {
	phase: Phase;
	endsOn: IsoDate;
}

/**
 * `block`, given by generateNextBlock, is the block actually planned: the priorities, the weeks
 * they and the doses cover, and priority_resolved's span follow it, not the first block of the
 * fresh season planSeason plans from its Monday.
 */
export function prepare(
	input: ProgrammingInput,
	options: GenerateOptions,
	log: DecisionLog,
	block?: PlannedBlock
): Prepared {
	const shaping = input.maintenance ? input.paused : input.goals;
	if (!shaping.length) return { input, periodisation: null };
	const planned = planSeason(input, options.startsOn);
	if ('refusal' in planned) return { input, periodisation: null };
	const season = input.maintenance ? firstBlockOnly(planned) : planned;

	const first = season.blocks[0]!;
	const phase = block?.phase ?? first.phase;
	const endsOn = block?.endsOn ?? first.endsOn;
	const mondays = block
		? Array.from({ length: (daysBetween(options.startsOn, endsOn) + 1) / 7 }, (_, i) =>
				addDays(options.startsOn, 7 * i)
			)
		: first.weeks.length
			? first.weeks.map((w) => w.startsOn)
			: [first.startsOn];
	const dosesOn = (monday: IsoDate) =>
		season.dosesByWeek.find((w) => w.startsOn === monday)?.doses ?? [];
	// The season's doses hold a goal where its windows overlap (a lower-ranked event's run-up
	// inside the leader's): a secondary goal is at maintenance that week. The goal that leads a
	// week is never dosed, as where the season keeps M3's first block over a maintenance window.
	const weeks = mondays.map((startsOn) => {
		const on = effectivePriorities(input, startsOn, { phase });
		if (phase === 'maintenance') {
			return { startsOn, priorities: holdEveryGoal(on), doses: dosesOn(startsOn) };
		}
		const leader = on.find((p) => p.mode === 'primary');
		const doses = dosesOn(startsOn).filter((d) => d.goal.id !== leader?.goalId);
		const priorities = on.map((p) => {
			const dose = doses.find((d) => d.goal.id === p.goalId);
			return dose && p.mode === 'secondary'
				? { ...p, mode: 'maintenance' as const, why: dose.reason }
				: p;
		});
		return { startsOn, priorities, doses };
	});
	const prioritiesByWeek = weeks.map(({ startsOn, priorities }) => ({ startsOn, priorities }));
	const dosesByWeek = weeks.map(({ startsOn, doses }) => ({ startsOn, doses }));
	const week1 = prioritiesByWeek[0]!.priorities;
	const modes = Object.fromEntries(week1.map((p) => [p.goalId, p.mode]));
	const ordered = input.maintenance ? input : reordered(input, week1);
	recordPriorities(prioritiesByWeek, endsOn, log);
	return {
		input: { ...ordered, modes },
		periodisation: { season, prioritiesByWeek, dosesByWeek }
	};
}
