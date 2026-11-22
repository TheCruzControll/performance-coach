/**
 * How screens name the seven days (weekdays.ts re-exports it). Its own module so the calendar,
 * which needs only WEEKDAYS, does not bring these labels into every route that does date math
 * (Progress's period picker among them): the labels load only where a screen names a day.
 */
import type { Weekday } from './weekdays.ts';

export const WEEKDAY_INFO: Record<Weekday, { short: string; letter: string; label: string }> = {
	mon: { short: 'Mon', letter: 'M', label: 'Monday' },
	tue: { short: 'Tue', letter: 'T', label: 'Tuesday' },
	wed: { short: 'Wed', letter: 'W', label: 'Wednesday' },
	thu: { short: 'Thu', letter: 'T', label: 'Thursday' },
	fri: { short: 'Fri', letter: 'F', label: 'Friday' },
	sat: { short: 'Sat', letter: 'S', label: 'Saturday' },
	sun: { short: 'Sun', letter: 'S', label: 'Sunday' }
};
