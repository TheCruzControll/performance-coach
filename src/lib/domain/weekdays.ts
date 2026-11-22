/**
 * The seven days of M2's schedule, Monday first, and how screens name them. Their own module so
 * the calendar and the analytics words can use them without the rest of the profile catalogue
 * (catalog.ts re-exports them): a screen that only names a weekday does not load every
 * discipline, goal and equipment label with it.
 */
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export { WEEKDAY_INFO } from './weekday-info.ts';
