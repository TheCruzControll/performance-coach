/**
 * Train's week as Instrument v2 says it (v2/07): the top line, the title and the line under it,
 * one line per session (a rest day is one line of its own), and the one line about the week that
 * opens its note. Words only, read from calendar strings and composed where the week is read
 * (Train's load, on the server), so the screen's initial JavaScript carries none of them.
 */
import { daysBetween, mondayOf, type IsoDate } from '#lib/domain/calendar.ts';
import { WEEKDAY_INFO, type Weekday } from '#lib/domain/weekdays.ts';
import type { SessionStatus } from '#lib/domain/training/vocabulary.ts';
import { longDate } from './words.ts';

const NUMBER_WORDS = [
	'none',
	'one',
	'two',
	'three',
	'four',
	'five',
	'six',
	'seven',
	'eight',
	'nine',
	'ten',
	'eleven',
	'twelve'
];

/** 0 to 12 in words, larger as digits: 'four', '14'. */
export const inWords = (n: number) => NUMBER_WORDS[n] ?? String(n);
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** A session as a line reads it: a SessionView fits. */
export interface LineSession {
	lineage: string;
	title: string;
	status: SessionStatus;
	estMinutes: number;
}
/** A day as the lines read it: a DayView fits. */
export interface LineDay {
	date: IsoDate;
	weekday: Weekday;
	sessions: readonly LineSession[];
}

/** One line of the week: a session (a link to it) or a rest day. */
export interface WeekLine {
	date: IsoDate;
	/** 'Mon', or 'Today'; '' on a day's second session, whose day the first line names. */
	day: string;
	/** The session's title, or 'Rest'. */
	title: string;
	/** Before today, today, or after: what colours the line. */
	when: 'past' | 'today' | 'ahead';
	/** A session's lineage (its link) and status; absent on a rest day. */
	session?: { lineage: string; status: SessionStatus };
	/** What ends the line: a tick once done, 'Skipped', the length; nothing on a rest day. */
	end: { done: true } | { text: string } | null;
	/** Its accessible name: 'Monday 9 November, Lower body, done'. */
	name: string;
}

/** Before today, today or after. */
export const lineWhen = (date: IsoDate, today: IsoDate): WeekLine['when'] =>
	date < today ? 'past' : date === today ? 'today' : 'ahead';

/** The week as lines, Monday first: each session on its own line (a day's second session leaves
 * the day blank), and a day with none as one 'Rest' line. */
export function weekLines(days: readonly LineDay[], today: IsoDate): WeekLine[] {
	return days.flatMap((d): WeekLine[] => {
		const label = d.date === today ? 'Today' : WEEKDAY_INFO[d.weekday].short;
		const base = { date: d.date, when: lineWhen(d.date, today) };
		if (d.sessions.length === 0)
			return [{ ...base, day: label, title: 'Rest', end: null, name: `${longDate(d.date)}, rest` }];
		return d.sessions.map((s, i) => {
			const end =
				s.status === 'completed'
					? ({ done: true } as const)
					: { text: s.status === 'skipped' ? 'Skipped' : `${s.estMinutes} min` };
			const state =
				s.status === 'completed'
					? 'done'
					: s.status === 'skipped'
						? 'skipped'
						: `${s.estMinutes} min`;
			return {
				...base,
				day: i === 0 ? label : '',
				title: s.title,
				session: { lineage: s.lineage, status: s.status },
				end,
				name: `${longDate(d.date)}, ${s.title}, ${state}`
			};
		});
	});
}

/** The week's title: 'This week', 'Last week' or 'Next week' by the calendar around today, else 'Week 9'. */
export function weekTitle(startsOn: IsoDate, today: IsoDate, number: number): string {
	const offset = daysBetween(mondayOf(today), startsOn) / 7;
	if (offset === 0) return 'This week';
	if (offset === -1) return 'Last week';
	if (offset === 1) return 'Next week';
	return `Week ${number}`;
}

/** The line under the title: 'Starts Monday 23 November' for a week still ahead (from `firstDay`
 * when the program starts later that week), else what is done: 'Four of six done', 'All six
 * done', and before any is done this week 'Six sessions this week'. */
export function weekStatus(
	days: readonly LineDay[],
	today: IsoDate,
	firstDay: IsoDate | null = null
): string {
	const startsOn = days[0]!.date;
	if (startsOn > today) {
		const from = firstDay && firstDay > startsOn ? firstDay : startsOn;
		return `Starts ${longDate(from)}`;
	}
	const sessions = days.flatMap((d) => d.sessions);
	const done = sessions.filter((s) => s.status === 'completed').length;
	const total = sessions.length;
	if (total === 0) return 'Nothing planned';
	if (done === total) return total === 1 ? 'Done' : `All ${inWords(total)} done`;
	if (done === 0 && days.at(-1)!.date >= today)
		return `${capital(inWords(total))} ${total === 1 ? 'session' : 'sessions'} this week`;
	return `${capital(inWords(done))} of ${inWords(total)} done`;
}

/** What the week's one line can open: each part present or absent. */
export interface WeekNoteParts {
	/** The findings' line ('2 heads-ups this week', 'No clashes this week'); null when none. */
	summary: string | null;
	/** How many distinct findings it shows (headsUps); 0 says only the summary. */
	findings: number;
	review: boolean;
	/** A light or special week's label: 'Deload week'. */
	kind: string | null;
	baseline: boolean;
	/** An open re-plan the goal priorities asked for. */
	replan: boolean;
	/** Any session's 'why this day'. */
	why: boolean;
}

/** The week's one line and whether it opens the week's note: the findings first, then a review's
 * changes, the week's kind, week 1's brief, a re-plan, and why a day holds its session. A clean
 * summary with nothing else to open is a plain line; with nothing at all, no line. */
export function weekNote(p: WeekNoteParts): { text: string; opens: boolean } | null {
	const opens = p.findings > 0 || p.review || !!p.kind || p.baseline || p.replan || p.why;
	const text =
		(p.findings > 0 && p.summary) ||
		(p.review && 'Updated from your weekly review') ||
		p.kind ||
		(p.baseline && 'What week 1 is for') ||
		(p.replan && 'Your coach suggests a new plan') ||
		p.summary ||
		(p.why && 'Why each day holds its session');
	return text ? { text, opens } : null;
}

/** The distinct findings among the cards' notes, in the week's order: two cards may share one. */
export function headsUps<T extends { text: string }>(
	notes: Readonly<Record<string, T>>,
	order: readonly string[]
): T[] {
	const seen = new Set<string>();
	return order.flatMap((lineage) => {
		const note = notes[lineage];
		if (!note || seen.has(note.text)) return [];
		seen.add(note.text);
		return [note];
	});
}

/** The top line: 'Week 3 of 14 · Build'; 'Week 9 · Peak' for a week not planned yet. */
export function weekPosition(number: number, of: number | null, name: string | null): string {
	return [of ? `Week ${number} of ${of}` : `Week ${number}`, name].filter(Boolean).join(' · ');
}
