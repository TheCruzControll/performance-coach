/**
 * Editing state for Profile → Goals, built from what the services return, and the words a goal
 * shows: when it is for on Goals, how it ended on Past goals, and the onboarding review's line
 * under its title. No Intl: a stored date needs no formatter, and building one is
 * measurable hydration cost on a phone (docs/performance.md).
 */
import type { Discipline, GoalStatus } from '#lib/domain/profile/catalog.ts';
import type { GoalInput } from '#lib/domain/profile/schemas.ts';
import type { Goal } from '#lib/domain/profile/types.ts';

/**
 * A goal being edited. Every text field is a string, '' when it is not set (the shared schema
 * turns '' back into null), and both kinds' fields are kept side by side: what the sheet does not
 * show, such as the notes, is posted back exactly as it was stored.
 */
export interface GoalDraft {
	/** The stored goal this edits; a new goal has none. */
	id?: string;
	kind: GoalInput['kind'];
	title: string;
	disciplines: Discipline[];
	customDiscipline: string;
	eventType: string;
	eventDate: string;
	weightClass: string;
	targetPerformance: string;
	requirements: string;
	focus: string;
	measure: string;
	targetDate: string;
	notes: string;
	/** Profile changes it in the sheet; elsewhere it is posted back as stored. */
	status: GoalStatus;
}

/** A blank goal of either kind: an event unless asked for a general goal. */
export function newGoal(kind: GoalDraft['kind'] = 'event'): GoalDraft {
	return {
		kind,
		title: '',
		disciplines: [],
		customDiscipline: '',
		eventType: '',
		eventDate: '',
		weightClass: '',
		targetPerformance: '',
		requirements: '',
		focus: '',
		measure: '',
		targetDate: '',
		notes: '',
		status: 'active'
	};
}

/** A stored goal, ready to edit. */
export function goalDraft(goal: Goal): GoalDraft {
	const text = (value: string | null) => value ?? '';
	return {
		id: goal.id,
		kind: goal.kind,
		title: goal.title,
		disciplines: [...goal.disciplines],
		customDiscipline: text(goal.customDiscipline),
		eventType: text(goal.eventType),
		eventDate: text(goal.eventDate),
		weightClass: text(goal.weightClass),
		targetPerformance: text(goal.targetPerformance),
		requirements: text(goal.requirements),
		focus: text(goal.focus),
		measure: text(goal.measure),
		targetDate: text(goal.targetDate),
		notes: text(goal.notes),
		status: goal.status
	};
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2027-03-14` → `14 Mar 2027`, read from the string: a calendar date has no time zone. */
export function shortIsoDate(iso: string | null): string {
	if (!iso) return '';
	const [year, month, day] = iso.split('-').map(Number);
	return `${day} ${MONTHS[month! - 1]} ${year}`;
}

/**
 * The line under a goal's title: `Muay Thai fight · 14 Mar 2027 · −71 kg` for an event,
 * `Deadlift strength · e1RM trend · by 30 Jun 2027` for a general goal.
 */
export function goalSummary(goal: Goal): string {
	const parts =
		goal.kind === 'event'
			? [goal.eventType, shortIsoDate(goal.eventDate), goal.weightClass]
			: [goal.focus, goal.measure, goal.targetDate && `by ${shortIsoDate(goal.targetDate)}`];
	return parts.filter(Boolean).join(' · ');
}

/** The months' names, January first: a date in words. */
export const MONTH_NAMES = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December'
];

/**
 * A goal row's value on Goals: when it is for. An event's date, `14 Mar`, with the year when it
 * is not `today`'s; a general goal's target, `By June` (or `By June 2028`); `Ongoing` without one.
 * A paused goal says `Paused` instead. Callers pass the device's date after hydration.
 */
export function goalWhen(goal: Goal, today: Date): string {
	if (goal.status === 'paused') return 'Paused';
	const iso = goal.kind === 'event' ? goal.eventDate : goal.targetDate;
	if (!iso) return 'Ongoing';
	const [year, month, day] = iso.split('-').map(Number);
	const thisYear = year === today.getFullYear();
	if (goal.kind === 'event') return `${day} ${MONTHS[month! - 1]}${thisYear ? '' : ` ${year}`}`;
	return `By ${MONTH_NAMES[month! - 1]}${thisYear ? '' : ` ${year}`}`;
}

/** A past goal's value on Past goals: achieved is done, anything else left is dropped. */
export const pastWhen = (goal: Pick<Goal, 'status'>): string =>
	goal.status === 'achieved' ? 'Done' : 'Dropped';

/**
 * Whole weeks from `today` (the device's date) to a stored calendar date, rounded down: 0 in the
 * last week and on the day itself, null once it has passed or when there is no date. Both are
 * compared as calendar days, so neither the time on the clock nor a daylight-saving change in
 * between moves the count. Callers pass the device's date after hydration, as Today's eyebrow.
 */
export function weeksUntil(iso: string | null, today: Date): number | null {
	if (!iso) return null;
	const [year, month, day] = iso.split('-').map(Number);
	const target = Date.UTC(year!, month! - 1, day!);
	const now = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
	const days = Math.round((target - now) / 86_400_000);
	return days < 0 ? null : Math.floor(days / 7);
}
