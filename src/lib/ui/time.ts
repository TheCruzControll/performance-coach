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

/** "just now", "12 min ago", "3 h ago", "yesterday", "4 days ago", then a short date. */
export function timeAgo(value: Date | string, now: Date = new Date()): string {
	const d = toDate(value);
	const seconds = Math.max(0, (now.getTime() - d.getTime()) / 1000);
	if (seconds < 60) return 'just now';
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.floor(hours / 24);
	if (days === 1) return 'yesterday';
	if (days < 7) return `${days} days ago`;
	return shortDate(d, now);
}
