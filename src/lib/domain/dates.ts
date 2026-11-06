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

/** ISO date (YYYY-MM-DD) of the calendar day `instant` falls on in `timeZone`. */
export function localDay(instant: Date, timeZone: string): string {
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone,
		year: 'numeric',
		month: '2-digit',
		day: '2-digit'
	}).formatToParts(instant);
	const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
	return `${part('year')}-${part('month')}-${part('day')}`;
}
