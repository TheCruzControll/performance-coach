/**
 * Today's day in words (Instrument v2, v2/06b): when a session is, what kind and how long, the
 * coach's one sentence, a rest, skipped or done day's sentence, the label of the one line under
 * the day, and each dot's mark in the week. Pure, read from calendar strings and the plan's own
 * words, and imported by plan.server.ts only, so none of it ships to the browser.
 */
import { daysBetween, weekdayOf, type IsoDate } from '#lib/domain/calendar.ts';
import type { SessionView } from '#lib/domain/training/types.ts';
import { SESSION_TYPE_LABEL } from '#lib/domain/training/vocabulary.ts';
import { WEEKDAY_INFO } from '#lib/domain/weekdays.ts';
import { inWords } from '#lib/ui/program/week-lines.ts';
import { longDate, shortDate } from '#lib/ui/program/words.ts';

/** A session as the day reads it: a SessionView fits. */
export type DaySession = Pick<
	SessionView,
	| 'lineage'
	| 'title'
	| 'kind'
	| 'type'
	| 'customDiscipline'
	| 'estMinutes'
	| 'timeOfDay'
	| 'status'
	| 'movedFrom'
	| 'source'
	| 'line'
	| 'date'
>;

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const MONTHS =
	'January February March April May June July August September October November December'.split(
		' '
	);

/** '2 November': a date without its weekday. */
export function dayMonth(date: IsoDate): string {
	const [, m, d] = date.split('-').map(Number) as [number, number, number];
	return `${d} ${MONTHS[m - 1]}`;
}

/** What kind of session, in a word: 'strength', 'run', 'class', 'conditioning', 'mobility'. */
export function kindWord(s: Pick<DaySession, 'kind' | 'type' | 'customDiscipline'>): string {
	if (s.kind === 'strength') return 'strength';
	if (s.kind === 'run') return 'run';
	if (s.type === 'muay_thai' || s.type === 'strength_class') return 'class';
	if (s.type === 'custom') return s.customDiscipline?.toLowerCase() || 'session';
	if (s.type === 'strength_conditioning') return 'conditioning';
	return SESSION_TYPE_LABEL[s.type].toLowerCase();
}

/** Its length: 'about 60 min' for a planned estimate, '90 min' for a class with a set length. */
export const lengthWords = (s: Pick<DaySession, 'estMinutes' | 'source'>) =>
	s.source === 'commitment' ? `${s.estMinutes} min` : `about ${s.estMinutes} min`;

const PART: Record<string, [lead: string, of: string]> = {
	early_morning: ['Early', 'morning'],
	morning: ['', 'morning'],
	midday: ['', 'at midday'],
	afternoon: ['', 'afternoon'],
	evening: ['', 'evening']
};

/** When, in words, as the day's line opens: 'This morning', 'Tomorrow evening', 'Early Saturday
 * morning', 'Saturday', 'Today'. */
export function whenWords(
	date: IsoDate,
	today: IsoDate,
	timeOfDay: DaySession['timeOfDay']
): string {
	const ahead = daysBetween(today, date);
	const part = timeOfDay && timeOfDay !== 'varies' ? PART[timeOfDay] : undefined;
	if (ahead === 0) {
		if (!part) return 'Today';
		if (timeOfDay === 'midday') return 'At midday';
		return part[0] ? `Early this ${part[1]}` : `This ${part[1]}`;
	}
	const day = ahead === 1 ? 'Tomorrow' : WEEKDAY_INFO[weekdayOf(date)].label;
	if (!part) return day;
	if (timeOfDay === 'midday') return `${day} at midday`;
	if (part[0]) return ahead === 1 ? 'Early tomorrow morning' : `Early ${day} morning`;
	return `${day} ${part[1]}`;
}

/** The day's when line: 'This morning · strength · about 60 min'; 'Your first session · …'. */
export function whenLine(s: DaySession, today: IsoDate, first = false): string {
	const when = first ? 'Your first session' : whenWords(s.date, today, s.timeOfDay);
	return `${when} · ${kindWord(s)} · ${lengthWords(s)}`;
}

/** The coach's one sentence on a session (D6): chosen from the plan's own words, not written.
 * Null only for a session with no words of its own to fall back on. */
export function coachLine(
	s: DaySession,
	ctx: { baseline: boolean; first: boolean; weekKind: { label: string; why: string } | null }
): string | null {
	if (s.movedFrom) return `You moved this from ${WEEKDAY_INFO[weekdayOf(s.movedFrom)].label}.`;
	if (ctx.baseline && s.kind === 'strength')
		return ctx.first
			? 'Start light today. I’ll set your weights from how these sets feel.'
			: 'Baseline week. Finish every set with two reps still in you.';
	if (ctx.baseline) return 'Baseline week. Go at the effort shown.';
	if (ctx.weekKind)
		return `${ctx.weekKind.label}. ${capital(ctx.weekKind.why).replace(/\.?$/, '.')}`;
	return s.line ? s.line.replace(/\.?$/, '.') : null;
}

/** A rest day's sentence: what is done this week so far. */
export function restLine(doneThisWeek: number): string {
	if (doneThisWeek === 0) return 'Nothing planned. Recovery is part of the plan.';
	const n = capital(inWords(doneThisWeek));
	return doneThisWeek === 1
		? 'Nothing planned. One session done this week, so let it land.'
		: `Nothing planned. ${n} sessions done this week, so let them land.`;
}

/** A skipped day's sentence: 'Long run. The rest of the week stays as it is.' (D8) */
export function skippedLine(titles: readonly string[]): string {
	const names =
		titles.length > 1 ? `${titles.slice(0, -1).join(', ')} and ${titles.at(-1)}` : titles[0]!;
	return `${names}. The rest of the week stays as it is.`;
}

/** Minutes in words: '58 min', '1 h', '1 h 28 min'. */
export function minutesWords(minutes: number): string {
	const h = Math.floor(minutes / 60);
	const m = minutes % 60;
	if (!h) return `${m} min`;
	return m ? `${h} h ${m} min` : `${h} h`;
}

/** A done day's when line: one session 'This morning · Full body · 58 min'; two 'Two sessions ·
 * 1 h 28 min'; a length only once every done session has one. */
export function doneLine(
	done: readonly (DaySession & { seconds: number | null })[],
	today: IsoDate
): string {
	const known = done.every((d) => d.seconds !== null);
	const total = known
		? minutesWords(Math.round(done.reduce((t, d) => t + d.seconds!, 0) / 60))
		: null;
	if (done.length === 1) {
		const d = done[0]!;
		return [whenWords(d.date, today, d.timeOfDay), d.title, total].filter(Boolean).join(' · ');
	}
	return [`${capital(inWords(done.length))} sessions`, total].filter(Boolean).join(' · ');
}

/** A line's label for a session on `date`: 'Later' (today), 'Tomorrow', 'Monday' within six
 * days, else 'Mon 16 Nov'. */
export function lineLabel(date: IsoDate, today: IsoDate): string {
	const ahead = daysBetween(today, date);
	if (ahead === 0) return 'Later';
	if (ahead === 1) return 'Tomorrow';
	return ahead > 1 && ahead < 7 ? WEEKDAY_INFO[weekdayOf(date)].label : shortDate(date);
}

const PART_LABEL: Record<string, string> = {
	early_morning: 'Early',
	morning: 'Morning',
	midday: 'Midday',
	afternoon: 'Afternoon',
	evening: 'Evening'
};

/** A done session's label: its time of day ('Morning'), or its weekday's short name. */
export const doneLabel = (s: Pick<DaySession, 'timeOfDay' | 'date'>) =>
	s.timeOfDay && s.timeOfDay !== 'varies'
		? PART_LABEL[s.timeOfDay]!
		: WEEKDAY_INFO[weekdayOf(s.date)].short;

/** Before week 1: the title is the start's weekday within six days, else its long date. */
export function startsTitle(startsOn: IsoDate, today: IsoDate): string {
	const ahead = daysBetween(today, startsOn);
	return ahead > 0 && ahead < 7 ? WEEKDAY_INFO[weekdayOf(startsOn)].label : longDate(startsOn);
}
export const STARTS_LEAD =
	'Week 1 starts · Nothing is planned before then. Rest, or train as you like and log it.';

/** Between blocks: 'Between blocks · Peak starts Monday 4 January. Nothing is planned until
 * then, so train as you like.' */
export const bridgeLead = (next: string | null, startsOn: IsoDate) =>
	`Between blocks · ${next ?? 'Your next block'} starts ${longDate(startsOn)}. Nothing is planned until then, so train as you like.`;

/** Every planned week trained: 'All 14 weeks trained · You trained 2 November to 7 February.
 * I plan the next block from how this one went.' A single week reads 'One week trained'. */
export const completeLead = (weeks: number, first: IsoDate, last: IsoDate) =>
	`${weeks === 1 ? 'One week' : `All ${inWords(weeks)} weeks`} trained · You trained ${dayMonth(first)} to ${dayMonth(last)}. I plan the next block from how this one went.`;

/** The top goal's line: null when it has no date or the date has passed (D11). */
export function goalEnd(date: IsoDate | null, today: IsoDate): string | null {
	if (!date) return null;
	const days = daysBetween(today, date);
	if (days < 0) return null;
	const weeks = Math.floor(days / 7);
	if (weeks === 0) return 'Less than a week to go';
	return `${weeks} ${weeks === 1 ? 'week' : 'weeks'} to go`;
}

/** A dot's mark in the week. */
export type DotMark = 'done' | 'today' | 'today-done' | 'planned' | 'skipped' | 'rest';

/** A day's mark: no sessions 'rest'; all resolved with one done 'done' ('today-done' today);
 * all skipped 'skipped'; today otherwise 'today'; else 'planned'. */
export function dotMark(
	statuses: readonly SessionView['status'][],
	date: IsoDate,
	today: IsoDate
): DotMark {
	if (!statuses.length) return 'rest';
	const open = statuses.some((s) => s === 'planned' || s === 'moved');
	if (!open && statuses.includes('completed')) return date === today ? 'today-done' : 'done';
	if (!open) return 'skipped';
	return date === today ? 'today' : 'planned';
}
