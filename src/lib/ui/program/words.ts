/**
 * What the program components say: a day's name in WeekStrip, a session's line and status in
 * SessionCard, and dates in words ('Monday 9 November', 'Mon 9 Nov') for Train's headings. Read
 * from calendar strings (`YYYY-MM-DD`) and the training vocabulary, never from the device's
 * clock or time zone, and without Intl.
 *
 * The components only lay these words out: stripDay and cardView compose them where the week is
 * read (Train's load, on the server), so a screen's initial JavaScript carries none of the
 * vocabulary (docs/performance.md).
 */
import { weekdayOf, type IsoDate } from '#lib/domain/calendar.ts';
import {
	TIME_OF_DAY_LABEL,
	WEEKDAY_INFO,
	type DisciplineTone,
	type Weekday
} from '#lib/domain/profile/catalog.ts';
import type { SessionView } from '#lib/domain/training/types.ts';
import {
	SESSION_INTENSITY_LABEL,
	SESSION_TYPE_LABEL,
	sessionTone
} from '#lib/domain/training/vocabulary.ts';

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

/** The day of the month and the month's name. */
function dayAndMonth(date: IsoDate): [day: number, month: string] {
	const [, month, day] = date.split('-').map(Number) as [number, number, number];
	return [day, MONTHS[month - 1]!];
}

/** 'Wednesday 4 November'. */
export function longDate(date: IsoDate): string {
	const [day, month] = dayAndMonth(date);
	return `${WEEKDAY_INFO[weekdayOf(date)].label} ${day} ${month}`;
}

/** 'Wed 4 Nov'. */
export function shortDate(date: IsoDate): string {
	const [day, month] = dayAndMonth(date);
	return `${WEEKDAY_INFO[weekdayOf(date)].short} ${day} ${month.slice(0, 3)}`;
}

/** A day's accessible name: 'Wednesday 4 November, today, 2 sessions, 1 done, 1 skipped'. */
export function dayName(day: StripDay, today: IsoDate | null): string {
	const done = day.sessions.filter((s) => s.status === 'completed').length;
	const skipped = day.sessions.filter((s) => s.status === 'skipped').length;
	return [
		longDate(day.date),
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

/** A WeekStrip day in words (stripDay): what the strip lays out. */
export interface StripDayView {
	date: IsoDate;
	/** Its accessible name (dayName). */
	name: string;
	/** 'W' and 'Wed'. */
	letter: string;
	short: string;
	/** A dot per session: its discipline's colour, a ring once skipped. */
	dots: readonly { tone: DisciplineTone; skipped: boolean }[];
}

export function stripDay(day: StripDay, today: IsoDate | null): StripDayView {
	const { letter, short } = WEEKDAY_INFO[day.weekday];
	return {
		date: day.date,
		name: dayName(day, today),
		letter,
		short,
		dots: day.sessions.map((s) => ({ tone: sessionTone(s.type), skipped: s.status === 'skipped' }))
	};
}

/** A SessionCard's session in words (cardView): what the card lays out. */
export interface CardView extends Pick<SessionView, 'title' | 'status'> {
	/** sessionLine. */
	line: string;
	/** statusWords: none while planned. */
	statusWords: string | null;
	tone: DisciplineTone;
}

export function cardView(session: CardSession): CardView {
	return {
		title: session.title,
		status: session.status,
		line: sessionLine(session),
		statusWords: statusWords(session),
		tone: sessionTone(session.type)
	};
}
