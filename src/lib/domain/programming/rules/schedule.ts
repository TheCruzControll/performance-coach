/**
 * The week scheduler's judgement calls (m7/21 week-scheduler): how schedule/repair.ts turns a
 * week's findings into a better week. Each is a default the owner can change in one edit here
 * (m7-plan open question on the coaching numbers); the rules registry lists them
 * (registry/schedule.ts).
 */
import type { OtherSessionKind, SessionIntensity } from '../../training/vocabulary.ts';

/**
 * What the scheduler may do to a session a finding names, in the order it tries them, each with
 * its reason. It tries every cheaper kind before a dearer one, and takes the first change that
 * lowers the week's cost (OBJECTIVE):
 * - move: another free day of the same week, nearest first; a commitment day only as a double
 * - swap: trade days with another session of the week that may move
 * - time: another time of day, for the same-day order and separation rules only
 * - ease: hard becomes moderate, heavy lower body is capped at RPE 7, sparring becomes pads
 * - drop: the last resort, and only for a generated session whose goal ranks below every goal
 *   the finding names
 */
export const ACTIONS = {
	move: 'A session that moves keeps all of its work, so moving it costs the least.',
	swap: 'Two sessions trading days keep all of their work, when neither fits a free day alone.',
	time: 'Two sessions on one day can be put in the right order, or far enough apart, by the clock.',
	ease: 'An easier session keeps the habit and most of the stimulus when no day avoids the clash.',
	drop: 'Leaving a session out loses its work, so it is kept for a clash nothing else fixes.'
} as const;
export type ScheduleAction = keyof typeof ACTIONS;

/** The rules a time-of-day change can fix: the order and the gap within one day. */
export const TIME_RULES: readonly string[] = [
	'placement.same_day_order',
	'concurrent.same_day_priority_order',
	'concurrent.same_day_separation'
];

/**
 * What a week costs, to be lowered. Avoid findings outweigh everything else, then prefer findings
 * and load peaks, then staying close to the days the week came with:
 * - avoid: 1,000 per avoid finding × (1 + the losing goal's weight), so the leader's sessions are
 *   protected first (the weight is 1 without priorities)
 * - prefer: 10 per prefer finding
 * - spread: per AU of the standard deviation of the days' hard load (minutes × RPE), so a week
 *   with its hard work spread out costs less than one with peaks
 * - dayMoved: 0.1 per day a session moves from where it was given
 * - ease 50 and drop 500, per session: losing work costs more than any prefer finding
 * - longRunOffWeekend: a long run on a weekday, when the weekend has the time it needs
 */
export const OBJECTIVE = {
	avoid: 1000,
	prefer: 10,
	spread: 0.005,
	dayMoved: 0.1,
	ease: 50,
	drop: 500,
	longRunOffWeekend: 20
} as const;

/**
 * The search's bounds, so a week is repaired in a known time: at most 4 passes over the findings,
 * and at most 400 evaluations of a week in all. A greedy search can stop short of the best week;
 * what it cannot fix is reported with its trade-off, never hidden.
 */
export const BOUNDS = { passes: 4, evaluations: 400 } as const;

/**
 * What the scheduler never changes: fixed commitments, sessions already past, completed or
 * skipped, and the owner's own moves unless the caller passes keepOwnerMoves false (an
 * owner-facing suggestion, which may move the owner's own conflicting session).
 */
export const FIXED = {
	commitments: 'A class or club keeps its day: the owner does not set its time.',
	past: 'A day that has passed cannot be planned again.',
	completed: 'A session already done is history.',
	skipped: 'A skipped session will not happen, so it cannot clash.',
	ownerMoves:
		'The owner chose that day; only a suggestion made to the owner may move it again (keepOwnerMoves false).'
} as const;

/**
 * What every change keeps (M3's rules):
 * - the day rule: one generated session on a free day; a second one on a commitment day only under
 *   DOUBLES (rules/days.ts)
 * - the weekend long run: a long run on Saturday or Sunday stays on the weekend (placement's
 *   PLACEMENT.longRunDays)
 * - the week: a session moves only within its own Monday-to-Sunday week, to an open day not past
 */
export const KEPT = {
	dayRule: 'One session a free day, and a double only beside a commitment, under DOUBLES.',
	weekendLongRun: 'The weekend has the time a long run needs, so it stays there.',
	ownWeek: 'A session belongs to its week: its targets and its load are that week’s.'
} as const;

/**
 * What easing does to a session: a hard or very hard session becomes `intensity`, every lower-body
 * set and the session's own target RPE are capped at `rpe`, and sparring becomes `sparringTo`.
 */
export const EASE = {
	from: ['hard', 'very_hard'],
	intensity: 'moderate',
	rpe: 7,
	sparringTo: 'pad_work'
} as const satisfies {
	from: readonly SessionIntensity[];
	intensity: SessionIntensity;
	rpe: number;
	sparringTo: OtherSessionKind;
};
