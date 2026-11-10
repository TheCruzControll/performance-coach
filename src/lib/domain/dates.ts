/**
 * Calendar days in the owner's time zone. Pure functions over `Intl`, no I/O.
 *
 * Day-dated records (a weigh-in, later a workout) belong to the day the owner lived, not the UTC
 * one: 18:30 in Los Angeles is already tomorrow in UTC.
 */

let supportedZones: Set<string> | undefined;

/**
 * The IANA time zone `value` names, spelled the way this engine resolves it
 * (`america/los_angeles` → `America/Los_Angeles`), or null when `Intl` does not support it.
 */
export function canonicalTimeZone(value: string): string | null {
	let zone: string;
	try {
		zone = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
	} catch {
		return null;
	}
	// `Intl` also accepts fixed offsets such as `+05:30`, which are not IANA zones (no daylight
	// saving rules). Its list of zones leaves out UTC itself.
	supportedZones ??= new Set(Intl.supportedValuesOf('timeZone'));
	return zone === 'UTC' || supportedZones.has(zone) ? zone : null;
}

/**
 * Each time zone's day formatter, made once, and the days it has already given by instant:
 * building an Intl.DateTimeFormat, and even formatting with one, costs far more than a lookup, and
 * the analytics ask for the day of every fact several times over (tens of thousands on 'all').
 * A zone's memo is emptied once it holds DAY_MEMO_MAX days, so it stays small in a long process.
 */
export const DAY_MEMO_MAX = 50_000;
const dayFormats = new Map<string, { format: Intl.DateTimeFormat; days: Map<number, string> }>();

function zoneDays(timeZone: string) {
	let zone = dayFormats.get(timeZone);
	if (!zone) {
		const format = new Intl.DateTimeFormat('en-US', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit'
		});
		zone = { format, days: new Map() };
		dayFormats.set(timeZone, zone);
	}
	return zone;
}

/** ISO date (YYYY-MM-DD) of the calendar day `instant` falls on in `timeZone`. */
export function localDay(instant: Date, timeZone: string): string {
	const { format, days } = zoneDays(timeZone);
	const ms = instant.getTime();
	const known = days.get(ms);
	if (known !== undefined) return known;
	const parts = format.formatToParts(instant);
	const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
	const day = `${part('year')}-${part('month')}-${part('day')}`;
	if (days.size >= DAY_MEMO_MAX) days.clear();
	days.set(ms, day);
	return day;
}
