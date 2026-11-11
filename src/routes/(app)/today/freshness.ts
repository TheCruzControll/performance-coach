/**
 * When Today's data is too old to show again: the app came back to the foreground (+page.svelte)
 * on another day than the one it loaded on, by the device's clock, or after `ttl`. Today names
 * the day and its plan, so neither may be yesterday's.
 */
export const TODAY_TTL_MS = 30 * 60_000;

const day = (date: Date) => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

export function isStale(loadedAt: Date, now: Date, ttl = TODAY_TTL_MS): boolean {
	return day(loadedAt) !== day(now) || now.getTime() - loadedAt.getTime() >= ttl;
}
