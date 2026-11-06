/**
 * What the program components say: a day's name in WeekStrip, and a session's line and status in
 * SessionCard. Read from calendar strings (`YYYY-MM-DD`) and the training vocabulary, never from
 * the device's clock or time zone, and without Intl: these ship in Train's, Today's and
 * History's initial JavaScript (docs/performance.md).
 */
import { weekdayOf, type IsoDate } from '#lib/domain/calendar.ts';
import { TIME_OF_DAY_LABEL, WEEKDAY_INFO, type Weekday } from '#lib/domain/profile/catalog.ts';
import type { SessionView } from '#lib/domain/training/types.ts';
import { SESSION_INTENSITY_LABEL, SESSION_TYPE_LABEL } from '#lib/domain/training/vocabulary.ts';

const MONTHS = [
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

/** A day of a WeekStrip: a WeekView's DayView fits. */
export interface StripDay {
	date: IsoDate;
	weekday: Weekday;
	sessions: readonly Pick<SessionView, 'type' | 'status'>[];
}

/** What a SessionCard shows: a SessionView fits. */
export type CardSession = Pick<
	SessionView,
	| 'title'
	| 'type'
	| 'customDiscipline'
	| 'estMinutes'
	| 'intensity'
	| 'timeOfDay'
	| 'status'
	| 'movedFrom'
>;

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** A day's accessible name: 'Wednesday 4 November, today, 2 sessions, 1 done, 1 skipped'. */
export function dayName(day: StripDay, today: IsoDate | null): string {
	const [, month, date] = day.date.split('-').map(Number) as [number, number, number];
	const done = day.sessions.filter((s) => s.status === 'completed').length;
	const skipped = day.sessions.filter((s) => s.status === 'skipped').length;
	return [
		`${WEEKDAY_INFO[day.weekday].label} ${date} ${MONTHS[month - 1]}`,
		day.date === today ? 'today' : null,
		day.sessions.length ? count(day.sessions.length, 'session', 'sessions') : 'no sessions',
		done ? `${done} done` : null,
		skipped ? `${skipped} skipped` : null
	]
		.filter((part) => part !== null)
		.join(', ');
}

/**
 * The card's line: 'Strength · 60 min · Hard · Evening'. A custom session says its own
 * discipline; the time of day is left out when unknown or 'varies', as describeSession does.
 */
export function sessionLine(session: CardSession): string {
	const time = session.timeOfDay;
	return [
		(session.type === 'custom' && session.customDiscipline) || SESSION_TYPE_LABEL[session.type],
		`${session.estMinutes} min`,
		SESSION_INTENSITY_LABEL[session.intensity],
		time === null || time === 'varies' ? null : TIME_OF_DAY_LABEL[time]
	]
		.filter((part) => part !== null)
		.join(' · ');
}

/** The status badge's words: none while planned; 'Moved from Mon' names the day it left. */
export function statusWords(session: Pick<SessionView, 'status' | 'movedFrom'>): string | null {
	switch (session.status) {
		case 'planned':
			return null;
		case 'skipped':
			return 'Skipped';
		case 'moved':
			return session.movedFrom
				? `Moved from ${WEEKDAY_INFO[weekdayOf(session.movedFrom)].short}`
				: 'Moved';
		case 'completed':
			return 'Done';
	}
}
