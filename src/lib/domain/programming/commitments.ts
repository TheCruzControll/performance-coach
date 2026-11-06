/**
 * Fixed commitments as sessions (PRD §5; m3-plan 'One day rule'). Each commitment is a session
 * on each of its weekdays in every planned week, from the first planned day, with its time of
 * day, its duration and intensity (told, or defaulted by input.ts and explained by blocks.ts as
 * default_assumed decisions), a target RPE from that intensity and the commitment it comes from.
 * By its quota (COMMITMENT_QUOTA, which allocateWeek has already counted):
 * - running: a run of one timed segment, which running.ts counts in the week's volume
 * - strength: a strength_class, the class setting its content, so no hard sets are credited
 * - Muay Thai, athletic and custom: an other session of its own type
 * Each commitment writes one commitment_placed decision citing every session it placed.
 *
 * Pure: no clock, no randomness, no I/O.
 */
import { addDays, weekdayOf } from '../calendar.ts';
import type { IsoDate } from '../calendar.ts';
import {
	DISCIPLINE_INFO,
	TIME_OF_DAY_LABEL,
	TIMES_OF_DAY,
	WEEKDAY_INFO
} from '../profile/catalog.ts';
import type { TimeOfDay } from '../profile/catalog.ts';
import { sessionLoadOf } from '../training/metrics.ts';
import type { BlockPlan, PlanPath, SessionPlan } from '../training/types.ts';
import { fromCommitmentIntensity } from '../training/vocabulary.ts';
import type { DecisionLog } from './decisions.ts';
import { clip, commitmentQuota, commitmentStream } from './demand.ts';
import type { WeekDemand } from './demand.ts';
import type { InputCommitment, ProgrammingInput } from './input.ts';
import { COMMITMENT_RPE, COMMITMENT_RUN, COMMITMENT_TYPE } from './rules/running.ts';
import type { GenerateOptions } from './stage.ts';

/** 'Tuesday and Thursday'; 'Monday, Wednesday and Friday'. */
export const inWords = (items: readonly string[]) =>
	items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/** A planned session as decisions cite it. */
export const sessionPath = (block: number, week: number, session: number): PlanPath =>
	`blocks.${block}.weeks.${week}.sessions.${session}`;

/** The next place in `date`'s order: after every session already on it. */
export const nextOrder = (sessions: readonly SessionPlan[], date: IsoDate) =>
	Math.max(0, ...sessions.filter((s) => s.date === date).map((s) => s.orderInDay)) + 1;

/** A day's commitments in the order of their times; an unknown or varying time goes last. */
const timeRank = (time: TimeOfDay | null) =>
	time === null ? TIMES_OF_DAY.length : TIMES_OF_DAY.indexOf(time);

function commitmentSession(
	c: InputCommitment,
	ref: string,
	date: IsoDate,
	orderInDay: number
): SessionPlan {
	const targetRpe = COMMITMENT_RPE[c.intensity];
	const minutes = c.durationMinutes;
	const base = {
		date,
		timeOfDay: c.timeOfDay,
		orderInDay,
		title: clip(c.label, 60),
		discipline: c.discipline,
		customDiscipline: c.discipline === 'custom' ? clip(c.label, 40) : null,
		intensity: fromCommitmentIntensity(c.intensity),
		estMinutes: minutes,
		estLoad: sessionLoadOf({ estMinutes: minutes, targetRpe }),
		targetRpe,
		source: 'commitment' as const,
		commitmentRef: ref,
		instructions: null,
		notes: null
	};
	// The disciplines COMMITMENT_QUOTA counts as runs.
	if (c.discipline === 'running' || c.discipline === 'distance_running') {
		const run = COMMITMENT_RUN[c.intensity];
		const segment = {
			kind: run.segment,
			repeatGroup: null,
			repeats: null,
			distanceMetres: null,
			durationSeconds: minutes * 60,
			paceMinSecondsPerKm: null,
			paceMaxSecondsPerKm: null,
			hrZone: run.hrZone,
			targetRpe
		};
		return { ...base, kind: 'run', type: run.type, segments: [segment] };
	}
	const details = {
		kind: 'class' as const,
		durationMinutes: minutes,
		targetRpe,
		metrics: [],
		notes: null
	};
	return { ...base, kind: 'other', type: COMMITMENT_TYPE[c.discipline], details };
}

/** The facts of the commitment_placed decision about commitment `i`. */
function placedFacts(c: InputCommitment, i: number, demand: WeekDemand, input: ProgrammingInput) {
	const share = demand.allocation.streams.find((s) => s.stream === commitmentStream(c));
	const quota = commitmentQuota(c);
	const own =
		c.discipline === 'custom'
			? (share?.goal.customDiscipline ?? c.label)
			: DISCIPLINE_INFO[c.discipline].short;
	const counts = !share
		? 'No goal of yours trains it, so it adds to your week rather than taking a planned session’s place.'
		: quota === 'runs'
			? `It counts as one of your runs, and its ${c.durationMinutes} minutes count toward your weekly running.`
			: quota === 'strength'
				? 'It counts as one of your strength days. The class sets its content, so no hard sets are credited for it.'
				: `It counts as one of your ${clip(own, 40)} sessions.`;
	const assumed = (field: string) =>
		input.assumptions.some((a) => a.field === `commitments.${i}.${field}`);
	const missing = [
		assumed('durationMinutes') ? 'how long it lasts' : null,
		assumed('intensity') ? 'how hard it is' : null
	].filter((x) => x !== null);
	return {
		commitment: clip(c.label, 60),
		days: inWords(c.days.map((d) => WEEKDAY_INFO[d].label)),
		time:
			c.timeOfDay === null || c.timeOfDay === 'varies'
				? ''
				: ` (${TIME_OF_DAY_LABEL[c.timeOfDay].toLowerCase()})`,
		minutes: c.durationMinutes,
		intensity: c.intensity,
		counts,
		assumed: missing.length
			? ` You haven’t said ${missing.join(' or ')}, so the coach assumed ${missing.length > 1 ? 'both' : 'it'}.`
			: ''
	};
}

/** Every commitment on each of its weekdays in every planned week, from the first planned day. */
export function placeCommitments(
	blocks: readonly BlockPlan[],
	demand: WeekDemand,
	input: ProgrammingInput,
	{ firstPlannedDay }: GenerateOptions,
	log: DecisionLog
): BlockPlan[] {
	const byTime = input.commitments
		.map((c, i) => ({ c, i }))
		.sort((a, b) => timeRank(a.c.timeOfDay) - timeRank(b.c.timeOfDay));
	const placed: PlanPath[][] = input.commitments.map(() => []);
	const planned = blocks.map((block, b) => ({
		...block,
		weeks: block.weeks.map((week, w) => {
			const sessions = [...week.sessions];
			for (let day = 0; day < 7; day++) {
				const date = addDays(week.startsOn, day);
				if (date < firstPlannedDay) continue;
				for (const { c, i } of byTime.filter(({ c }) => c.days.includes(weekdayOf(date)))) {
					placed[i]!.push(sessionPath(b, w, sessions.length));
					const ref = input.refs.commitments[i]!;
					sessions.push(commitmentSession(c, ref, date, nextOrder(sessions, date)));
				}
			}
			return { ...week, sessions };
		})
	}));
	input.commitments.forEach((c, i) => {
		log.add('commitment_placed', 'commitments.fixed', placed[i]!, placedFacts(c, i, demand, input));
	});
	return planned;
}
