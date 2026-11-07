/**
 * When a new program starts (m3-plan 'The owner's local date'): week 1 is the Monday-to-Sunday
 * week `startsOn` names, and `firstPlannedDay` is its first day with sessions. Both come from the
 * owner's local today, which the caller passes; nothing here reads a clock.
 *
 * - 'next_monday': week 1 is next week, whole (today, when today is a Monday).
 * - 'this_week': week 1 is this week, planned from today on. It is offered only while the plan
 *   contract allows a part first week (PARTIAL_FIRST_WEEK).
 */
import * as z from 'zod/mini';
import { addDays, mondayOf, type IsoDate } from '../../../domain/calendar';
import { PARTIAL_FIRST_WEEK } from '../../../domain/training/schemas';

export const PROGRAM_STARTS = ['next_monday', 'this_week'] as const;
export type ProgramStart = (typeof PROGRAM_STARTS)[number];

/**
 * Decision (m3-plan open question 'Program start'): a program starts next Monday unless the owner
 * picks 'This week'. Changing the default is this one line.
 */
export const DEFAULT_PROGRAM_START: ProgramStart = 'next_monday';

/** The starts the Build preview offers: 'This week' only while a part first week is allowed. */
export const START_OPTIONS: readonly ProgramStart[] = PARTIAL_FIRST_WEEK
	? PROGRAM_STARTS
	: ['next_monday'];

export interface StartDates {
	/** The Monday of week 1. */
	startsOn: IsoDate;
	/** The first day with sessions: startsOn, or today for 'This week'. */
	firstPlannedDay: IsoDate;
}

/** Week 1's dates for a program started on `today`. */
export function startDates(today: IsoDate, start: ProgramStart): StartDates {
	const monday = mondayOf(today);
	if (start === 'this_week') return { startsOn: monday, firstPlannedDay: today };
	const next = monday === today ? today : addDays(monday, 7);
	return { startsOn: next, firstPlannedDay: next };
}

/** What a preview is asked for: the owner's local today, and when to start. */
export const previewRequestSchema = z.object({
	today: z.iso.date('Use a real date'),
	start: z
		.enum(PROGRAM_STARTS, 'Pick when to start')
		.check(z.refine((start) => START_OPTIONS.includes(start), 'Pick when to start'))
});
export type PreviewRequest = z.output<typeof previewRequestSchema>;
