/**
 * The days What the coach knows shows, in the app's date format ('Tue 10 Nov', as Train and
 * Progress write them), with the year only when it is not the year of the snapshot. A record's
 * day is a calendar day (`YYYY-MM-DD`), never an instant: no time zone, no clock and no Intl, so
 * the sheet's chunk stays small.
 */
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'Tue 10 Nov', or 'Tue 10 Nov 2025' when `day` falls in another year than `asOf`. */
export function knowsDate(day: string, asOf: string): string {
	const [year, month, date] = day.split('-').map(Number) as [number, number, number];
	const weekday = DAYS[new Date(Date.UTC(year, month - 1, date)).getUTCDay()];
	const words = `${weekday} ${date} ${MONTHS[month - 1]}`;
	return day.slice(0, 4) === asOf.slice(0, 4) ? words : `${words} ${year}`;
}
