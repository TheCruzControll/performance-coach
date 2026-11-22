/**
 * When a new program starts (m3-plan 'The owner's local date'): week 1 is the Monday-to-Sunday
 * week `startsOn` names, and `firstPlannedDay` is its first day with sessions. Both come from the
 * owner's local today, which the caller passes; nothing here reads a clock.
 *
 * - 'next_monday': week 1 is next week, whole (today, when today is a Monday).
 * - 'this_week': week 1 is this week, planned from today on. It is offered only while the plan
 *   contract allows a part first week (PARTIAL_FIRST_WEEK).
 * - a day (YYYY-MM-DD): week 1 is that day's week, planned from it, for a day from today to
 *   START_DAYS_AHEAD days ahead (start-move.ts's startDay).
 */
import * as z from 'zod/mini';
import { addDays, mondayOf, type IsoDate } from '../../../domain/calendar';
import { startFrom, type StartDates } from '../../../domain/programming/start-move';
import { PARTIAL_FIRST_WEEK } from '../../../domain/training/schemas';

export const PROGRAM_STARTS = ['next_monday', 'this_week'] as const;
/** A named start, as the coach and the Build's choices offer it. */
export type NamedStart = (typeof PROGRAM_STARTS)[number];
/** A named start, or a day (YYYY-MM-DD) week 1 is planned from (start-move.ts's startDay). */
export type ProgramStart = NamedStart | IsoDate;

/**
 * Decision (m3-plan open question 'Program start'): a program starts next Monday unless the owner
 * picks 'This week'. Changing the default is this one line.
 */
export const DEFAULT_PROGRAM_START: NamedStart = 'next_monday';

/** The named starts the Build preview offers: 'This week' only while a part first week is allowed. */
export const START_OPTIONS: readonly NamedStart[] = PARTIAL_FIRST_WEEK
	? PROGRAM_STARTS
	: ['next_monday'];

export type { StartDates };

/** What a field error at `start` says for a day outside the window. */
export const PICK_A_DAY = 'Pick a day from today to eight weeks ahead';

/** Week 1's dates: a named start's, or startFrom(day) for a day (not checked here). */
export function startDates(today: IsoDate, start: ProgramStart): StartDates {
	if (start === 'this_week') return { startsOn: mondayOf(today), firstPlannedDay: today };
	if (start !== 'next_monday') return startFrom(start);
	const monday = mondayOf(today);
	const next = monday === today ? today : addDays(monday, 7);
	return { startsOn: next, firstPlannedDay: next };
}

/** What a preview is asked for: the owner's local today, and when to start: a named start or a day. */
export const previewRequestSchema = z.object({
	today: z.iso.date('Use a real date'),
	start: z.union(
		[
			z.enum(PROGRAM_STARTS).check(z.refine((start) => START_OPTIONS.includes(start))),
			// zod reports a union that matches neither branch with the last branch's own message.
			z.iso.date('Pick when to start')
		],
		'Pick when to start'
	)
});
export type PreviewRequest = z.output<typeof previewRequestSchema>;
