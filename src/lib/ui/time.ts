/**
 * Compact, Intl-free time labels ("just now", "3 min ago", "5 Nov"). No `Intl` on purpose:
 * constructing formatters is measurable hydration cost on phones (docs/performance.md).
 */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const toDate = (value: Date | string) => (value instanceof Date ? value : new Date(value));

/** "5 Nov" (this year) or "5 Nov 2025". */
export function shortDate(value: Date | string, now: Date = new Date()): string {
	const d = toDate(value);
	const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
	return d.getFullYear() === now.getFullYear() ? day : `${day} ${d.getFullYear()}`;
}

/**
 * "just now", "12 min ago", "3 h ago", "yesterday" or "4 days ago"; null from 7 days, where a
 * date reads better. Only the interval counts, never the calendar, so it needs no time zone:
 * a server load can label times with the same `now` it sends the page (Profile → Security).
 */
export function relativeTime(value: Date | string, now: Date): string | null {
	const seconds = Math.max(0, (now.getTime() - toDate(value).getTime()) / 1000);
	if (seconds < 60) return 'just now';
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.floor(hours / 24);
	if (days === 1) return 'yesterday';
	if (days < 7) return `${days} days ago`;
	return null;
}

/** relativeTime, then a short date in this device's time zone. */
export function timeAgo(value: Date | string, now: Date = new Date()): string {
	return relativeTime(value, now) ?? shortDate(value, now);
}
