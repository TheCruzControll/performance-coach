/**
 * The seven days of M2's schedule, Monday first, and how screens name them. Their own module so
 * the calendar and the analytics words can use them without the rest of the profile catalogue
 * (catalog.ts re-exports them): a screen that only names a weekday does not load every
 * discipline, goal and equipment label with it.
 */
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const WEEKDAY_INFO: Record<Weekday, { short: string; letter: string; label: string }> = {
	mon: { short: 'Mon', letter: 'M', label: 'Monday' },
	tue: { short: 'Tue', letter: 'T', label: 'Tuesday' },
	wed: { short: 'Wed', letter: 'W', label: 'Wednesday' },
	thu: { short: 'Thu', letter: 'T', label: 'Thursday' },
	fri: { short: 'Fri', letter: 'F', label: 'Friday' },
	sat: { short: 'Sat', letter: 'S', label: 'Saturday' },
	sun: { short: 'Sun', letter: 'S', label: 'Sunday' }
};
