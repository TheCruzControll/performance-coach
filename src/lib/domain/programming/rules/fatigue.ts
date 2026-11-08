/**
 * How tired each body system is (M7's load model in the periodisation engine ADR): how fast a
 * system recovers, how its acute:chronic ratio is read, and when its fatigue is elevated or an
 * overload. load/fatigue.ts applies them; the rules registry lists them (registry/fatigue.ts).
 *
 * Every number is a coaching judgement and a default (m7-plan open question on the coaching
 * numbers), so each carries its reason and a change is one edit here.
 */
import { ACUTE_DAYS, CHRONIC_DAYS } from '../../analytics/workload.ts';
import type { LoadSystem } from '../evaluate/types.ts';

/** How tired a system is: fresh, elevated or overloaded, worst last. */
export const FATIGUE_LEVELS = ['fresh', 'elevated', 'overloaded'] as const;
export type FatigueLevel = (typeof FATIGUE_LEVELS)[number];

/**
 * Days for a system's residual fatigue to halve. A day's load joins the residual whole, and what
 * is left halves every half-life after it, so it needs no history to be read.
 */
export const HALF_LIVES: Readonly<Record<LoadSystem, { days: number; why: string }>> = {
	lower: {
		days: 2.5,
		why: 'Legs take longest: heavy squats, hinges and impact leave muscle damage that lasts two to three days.'
	},
	upper: {
		days: 2,
		why: 'The upper body’s smaller muscles recover a little faster than the legs.'
	},
	aerobic: {
		days: 1.5,
		why: 'The aerobic system recovers fastest: an easy day or two restores it.'
	},
	combat: {
		days: 2,
		why: 'Muay Thai’s knocks and hard rounds take about two days to shake off.'
	},
	cns: {
		days: 2,
		why: 'Near-maximal efforts tire the nervous system for about two days.'
	}
};

/**
 * M1's acute:chronic ratio over each system's daily load (M6's windows, as Progress shows it):
 * null under `chronicDays` of history. It counts only while the system carries at least
 * `needsResidual` × its typical hard session. Then a ratio of `elevated` or more makes the system
 * at least elevated, and one of `overloaded` or more makes it one level worse than its residual
 * alone says. It never jumps fresh to overloaded by itself: a system trained once a week spikes
 * a 7-day average on that day every week (about 1.8 for one weekly session), however steady the
 * training.
 */
export const RATIO = {
	acuteDays: ACUTE_DAYS,
	chronicDays: CHRONIC_DAYS,
	elevated: 1.3,
	overloaded: 1.5,
	needsResidual: 1,
	why:
		'About 1.3 means load is rising faster than you are used to, and 1.5 is a sharp rise (rules ' +
		'of thumb, M6’s caveat). A lone weekly session spikes the ratio without any rise, so it ' +
		'only counts while a hard session’s fatigue is still there, and moves the level one step.'
} as const;

/**
 * The residual against the system's typical hard session: above `elevated` × it, the system
 * carries more than a hard session's fatigue; above `overloaded` × it, close to two.
 */
export const RESIDUAL = {
	elevated: 1.2,
	overloaded: 1.75,
	why:
		'One hard session leaves a system at about 1 × its typical hard session; more than 1.2 × ' +
		'means fatigue is stacking. A steady week ends its hardest day at about 1.5 × (the legs, ' +
		'after squats, pads and deadlifts), so overload starts above that, at 1.75 ×.'
} as const;

/**
 * Where a system's typical hard session comes from. A system's hard session in a week is the
 * session that loads it most that week; its typical hard session is the median of those weeks.
 * Under `days` of logged history the weeks are the plan's planned sessions (before 28 days the
 * level comes from the residual alone, the ratio being null); from then on, the logged sessions of
 * the `days` before the day judged, or before today for a day ahead. Planned days are never
 * history, so a projection from the plan alone keeps the plan's. With none, the residual is not judged: there is no second EWMA
 * and no separate cold-start threshold.
 */
export const HISTORY = {
	days: CHRONIC_DAYS,
	why:
		'Fatigue is judged against your own training: what the plan asks of you until there are four ' +
		'weeks of logs, then what you actually did, so a beginner and an athlete each read true.'
} as const;
