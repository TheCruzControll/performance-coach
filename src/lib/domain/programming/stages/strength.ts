/**
 * Strength days filled with exercises (PRD §5): the split for the strength sessions the day rule
 * gives (../splits.ts) and each day's exercises (../selection.ts), in every planned week, each at
 * its week's RPE cap. The days are spaced naively until placement (m3/23): spread evenly over the
 * free days, then over the commitment days, and none before week 1's first planned day.
 */
import { addDays } from '../../calendar.ts';
import type { IsoDate } from '../../calendar.ts';
import { WEEKDAYS } from '../../profile/catalog.ts';
import type { Weekday } from '../../profile/catalog.ts';
import { sessionLoadOf } from '../../training/metrics.ts';
import type { SessionPlan, StrengthSessionPlan, WeekPlan } from '../../training/types.ts';
import type { WeekBudget } from '../demand.ts';
import type { ProgrammingInput } from '../input.ts';
import { INTENSITY_BY_RPE } from '../rules/strength.ts';
import { plannedExercise, selectWeek } from '../selection.ts';
import type { DaySelection } from '../selection.ts';
import { chooseSplit, splitFacts } from '../splits.ts';
import type { Split } from '../splits.ts';
import { demandIn } from '../stage.ts';
import type { Stage } from '../stage.ts';
import { estimateMinutes } from '../timefit.ts';

/** `n` of `days`, evenly spread and in order; all of them when there are no more. */
const spread = (days: readonly Weekday[], n: number) =>
	n >= days.length
		? [...days]
		: Array.from({ length: Math.max(0, n) }, (_, i) => days[Math.floor((i * days.length) / n)]!);

/** The weekday of each of `n` strength days: the free days first, then the commitment days. */
export function naiveDays({ days, commitmentWeekdays }: WeekBudget, n: number): Weekday[] {
	const free = days.filter((day) => !commitmentWeekdays.includes(day));
	return [...spread(free, n), ...spread(commitmentWeekdays, n - free.length)];
}

function sessionOn(
	date: IsoDate,
	{ day, exercises }: DaySelection,
	split: Split,
	week: WeekPlan,
	planned: readonly SessionPlan[],
	input: ProgrammingInput
): StrengthSessionPlan {
	const sameDay = planned.filter((s) => s.date === date);
	const targetRpe = week.targets.rpeCap;
	const prescribed = exercises.map((e) => plannedExercise(e, split, targetRpe));
	const estMinutes = estimateMinutes({ exercises: prescribed }, input);
	return {
		kind: 'strength',
		date,
		timeOfDay: input.preferredTimes.find((t) => !sameDay.some((s) => s.timeOfDay === t)) ?? null,
		orderInDay: Math.max(0, ...sameDay.map((s) => s.orderInDay)) + 1,
		type: split.type,
		title: day.title,
		discipline: split.discipline,
		customDiscipline: null,
		intensity: INTENSITY_BY_RPE.find(([under]) => targetRpe < under)![1],
		estMinutes,
		estLoad: sessionLoadOf({ estMinutes, targetRpe }),
		targetRpe,
		source: 'generator',
		commitmentRef: null,
		instructions: null,
		notes: null,
		exercises: prescribed
	};
}

export const strength: Stage = (draft, { input, options, log }) => {
	const { budget, allocation } = demandIn(draft);
	const share = allocation.streams.find((s) => s.stream === 'strength');
	if (!share?.generated) return draft;
	const split = chooseSplit(input, share.generated);
	const facts = splitFacts(split, input, share.committed);
	log.add('split_chosen', `strength.${split.layout}`, ['blocks.0'], facts);
	const days = selectWeek(split, input, log).filter((d) => d.exercises.length);
	const weekdays = naiveDays(budget, days.length);
	const blocks = draft.blocks.map((block) => ({
		...block,
		weeks: block.weeks.map((week) => {
			const sessions = [...week.sessions];
			days.forEach((day, i) => {
				const date = addDays(week.startsOn, WEEKDAYS.indexOf(weekdays[i]!));
				if (date >= options.firstPlannedDay) {
					sessions.push(sessionOn(date, day, split, week, sessions, input));
				}
			});
			return { ...week, sessions };
		})
	}));
	return { ...draft, blocks };
};
