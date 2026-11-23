/**
 * The words of the coach's Undo card for a weigh-in it logged (the weight plan's PR 9): "Logged
 * 82.4 kg for today", then Undo, then what Undo said. Pure, so the server words the card the turn
 * streams and the card a reload shows the same way, and the browser words the outcome.
 *
 * The day is named from the owner's today: 'today' and 'yesterday', else the weekday and the day
 * ('Mon 2 Nov', with the year in another year). A card kept past its day reads the day, not
 * 'yesterday'.
 */
import { addDays, weekdayOf, type IsoDate } from '../calendar.ts';
import { WEEKDAY_INFO } from '../weekday-info.ts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A logged weigh-in as the card words it: its value in its unit, and its day. */
export interface WeighInWords {
	value: number;
	unit: 'kg' | 'lb';
	measuredOn: IsoDate;
}

/** The day a weigh-in is for, from the owner's today: 'today', 'yesterday', 'Mon 2 Nov'. */
export function dayWords(day: IsoDate, today: IsoDate): string {
	if (day === today) return 'today';
	if (day === addDays(today, -1)) return 'yesterday';
	const [year, month, date] = day.split('-').map(Number) as [number, number, number];
	const yearWords = year === Number(today.slice(0, 4)) ? '' : ` ${year}`;
	return `${WEEKDAY_INFO[weekdayOf(day)].short} ${date} ${MONTHS[month - 1]}${yearWords}`;
}

/** 'Logged 82.4 kg for today': the card's label for a weigh-in the coach logged. */
export function weighInLabel(entry: WeighInWords, today: IsoDate): string {
	return `Logged ${entry.value} ${entry.unit} for ${dayWords(entry.measuredOn, today)}`;
}

/** The key a card is listed by, in a conversation and in a turn alike: its weigh-in's id. */
export const weighInKey = (id: number): string => `weigh-in:${id}`;

/** What the card reads once Undo took the write back. */
export const UNDONE = 'Undone';
/** What the card reads when the weigh-in is gone, or no longer the coach's write (404, 409). */
export const NOTHING_TO_UNDO = 'Nothing to undo';
/** What the card says when Undo did not go through: it can be tried again. */
export const UNDO_FAILED = 'Couldn’t undo it. Check your connection and try again.';
