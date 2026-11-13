/**
 * The week's demand (m3-plan 'One day rule'): how many days the program trains and how many
 * sessions each goal gets in them, by the numbers in rules/days.ts. Every stage reads this one
 * rule: strength (m3/17) its strength days, running and commitments (m3/18) its runs and other
 * sessions, placement (m3/23) the days and the doubles.
 *
 * Pure: no clock, no randomness, no I/O.
 */
import { WEEKDAYS } from '../profile/catalog.ts';
import type { Weekday } from '../profile/catalog.ts';
import type { DecisionLog } from './decisions.ts';
import type { InputCommitment, InputGoal, ProgrammingInput } from './input.ts';
import { COMMITMENT_QUOTA, DOUBLES, doubleTime, SESSIONS_WANTED } from './rules/days.ts';
import type { Quota, Stream } from './rules/days.ts';

export interface WeekBudget {
	/** Every weekday a session may go on: the available days and the commitment days. */
	days: Weekday[];
	/** The weekdays the owner's commitments take. */
	commitmentWeekdays: Weekday[];
	/** daysPerWeek, capped by `days`. */
	trainingDays: number;
	commitmentDays: number;
	/** The training days the commitments leave; never below 0. */
	freeDays: number;
	/** Whether any commitment day may also hold a generated session (DOUBLES). */
	doublesAllowed: boolean;
	/** The commitment days that may: one commitment, with a time left for a second session. */
	doubleDays: Weekday[];
}

/** What one goal's stream gets a week. */
export interface StreamShare {
	stream: Stream;
	/** The highest-priority goal that asks for it. */
	goal: InputGoal;
	/** Sessions a week from the owner's commitments. */
	committed: number;
	/** Sessions a week the generator plans, doubles included. */
	generated: number;
	min: number;
	max: number;
}

export interface WeekAllocation {
	/** The goals' streams, by priority. */
	streams: StreamShare[];
	/** Generated sessions that sit as a second session on a commitment day. */
	doubles: number;
	/** Free days no goal asks for: a mobility session each. */
	mobility: number;
}

export interface WeekDemand {
	budget: WeekBudget;
	allocation: WeekAllocation;
}

/** `text` cut to `max` characters, so a decision's fact stays inside the plan contract. */
export const clip = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

export function weekBudget(input: ProgrammingInput): WeekBudget {
	const commitmentWeekdays = WEEKDAYS.filter((d) =>
		input.commitments.some((c) => c.days.includes(d))
	);
	const days = WEEKDAYS.filter(
		(d) => input.availableDays.includes(d) || commitmentWeekdays.includes(d)
	);
	const trainingDays = Math.min(input.daysPerWeek, days.length);
	const doubleDays =
		input.sessionMinutes > DOUBLES.maxSessionMinutes
			? []
			: commitmentWeekdays.filter((d) => {
					const here = input.commitments.filter((c) => c.days.includes(d));
					return here.length === 1 && doubleTime(here[0]!.timeOfDay, input.preferredTimes) !== null;
				});
	return {
		days,
		commitmentWeekdays,
		trainingDays,
		commitmentDays: commitmentWeekdays.length,
		freeDays: Math.max(0, trainingDays - commitmentWeekdays.length),
		doublesAllowed: doubleDays.length > 0,
		doubleDays
	};
}

export function commitmentQuota(commitment: Pick<InputCommitment, 'discipline'>): Quota {
	return COMMITMENT_QUOTA[commitment.discipline];
}

/** The stream a commitment's sessions count toward: an 'other' class counts as its own kind. */
export function commitmentStream(commitment: InputCommitment): string {
	const quota = commitmentQuota(commitment);
	return quota === 'other' ? commitment.discipline : quota;
}

const total = (s: StreamShare) => s.committed + s.generated;

/** Sessions by stream: the commitments count first, then the free days go by goal priority. */
export function allocateWeek(
	input: ProgrammingInput,
	budget: WeekBudget,
	log: DecisionLog
): WeekAllocation {
	const goals = input.maintenance ? input.paused : input.goals;
	const streams: StreamShare[] = [];
	for (const discipline of input.disciplines) {
		const { stream, min, max } = SESSIONS_WANTED[discipline];
		const share = streams.find((s) => s.stream === stream);
		if (share) {
			share.min = Math.max(share.min, min);
			share.max = Math.max(share.max, max);
		} else {
			const goal = goals.find((g) => g.disciplines.includes(discipline))!;
			streams.push({ stream, goal, committed: 0, generated: 0, min, max });
		}
	}
	// At maintenance (every goal paused), no goal gets more than its fewest.
	if (input.maintenance) for (const s of streams) s.max = s.min;
	for (const c of input.commitments) {
		const share = streams.find((s) => s.stream === commitmentStream(c));
		if (share) share.committed += c.days.length;
	}

	/** Up to `days` sessions, to each stream by priority until it has its fewest; the rest stay. */
	const toTheFewest = (days: number) => {
		for (const s of streams) {
			const give = Math.min(days, Math.max(0, s.min - total(s)));
			s.generated += give;
			days -= give;
		}
		return days;
	};
	// 1. The free days.
	let free = toTheFewest(budget.freeDays);
	// 2. Still short: a second session on each commitment day that holds one, if allowed.
	const slots = budget.doubleDays.length;
	const doubles = slots - toTheFewest(slots);
	// 3. Spare days by turns, by priority, up to each stream's most.
	for (let gave = true; free > 0 && gave;) {
		gave = false;
		for (const s of streams) {
			if (free === 0 || total(s) >= s.max) continue;
			s.generated += 1;
			free -= 1;
			gave = true;
		}
	}
	const allocation = { streams, doubles, mobility: free };
	recordAllocation(input, budget, allocation, log);
	return allocation;
}

/** The generated sessions a week of one stream: 0 when no goal asks for it. */
export function generatedFor(allocation: WeekAllocation, stream: Stream): number {
	return allocation.streams.find((s) => s.stream === stream)?.generated ?? 0;
}

const NOUNS: Record<Stream | 'mobility', [one: string, many: string]> = {
	strength: ['strength session', 'strength sessions'],
	runs: ['run', 'runs'],
	muay_thai: ['Muay Thai session', 'Muay Thai sessions'],
	custom: ['session', 'sessions'],
	mobility: ['mobility session', 'mobility sessions']
};

function sessions(n: number, stream: Stream | 'mobility', goal?: InputGoal): string {
	const noun = NOUNS[stream][n === 1 ? 0 : 1];
	const own = stream === 'custom' ? `${goal?.customDiscipline ?? goal?.title} ` : '';
	return `${n} ${own}${noun}`;
}

function recordAllocation(
	input: ProgrammingInput,
	budget: WeekBudget,
	{ streams, doubles, mobility }: WeekAllocation,
	log: DecisionLog
) {
	const title = (goal: InputGoal) => clip(goal.title, 40);
	const given = [
		...streams
			.filter((s) => s.generated)
			.map((s) => `${sessions(s.generated, s.stream, s.goal)} for ${title(s.goal)}`),
		...(mobility ? [sessions(mobility, 'mobility')] : [])
	];
	const fill = budget.commitmentDays > 0 && budget.commitmentDays >= budget.trainingDays;
	const list = given.join(', ') || 'nothing else is planned';
	const allocation =
		(fill ? `your commitments fill the days you train, so no day is added; ${list}` : list) +
		(doubles ? `, ${doubles} of them as a second session on a commitment day` : '');
	log.add('day_allocation', fill ? 'days.commitments_fill' : 'days.free_days', [], {
		days: Math.max(budget.trainingDays, budget.commitmentDays),
		stated: input.daysPerWeek,
		available:
			budget.days.length < input.daysPerWeek
				? `, but only ${budget.days.length} days are available`
				: '',
		commitmentDays: budget.commitmentDays,
		freeDays: budget.freeDays,
		allocation: clip(allocation, 200)
	});

	// A stream short of its fewest lost its days to the goals ranked above it.
	const [top, ...rest] = streams;
	for (const s of rest.filter((s) => total(s) < s.min)) {
		const missing = `${s.min - total(s)} of ${sessions(s.min, s.stream, s.goal)}`;
		if (s === rest.at(-1) || s.goal === top!.goal) {
			log.add('session_dropped', 'days.dropped', [], {
				session: missing,
				reason: budget.doublesAllowed
					? 'every free day and every commitment day with room is taken'
					: `every free day is taken, and ${DOUBLES.rationale}`
			});
		} else {
			log.add('priority_tradeoff', 'days.priority', [], {
				kept: title(top!.goal),
				given: title(s.goal),
				reason: clip(
					`${title(top!.goal)} ranks above ${title(s.goal)}, so its sessions take the free days first, and ${missing} are left out.`,
					200
				)
			});
		}
	}
}
