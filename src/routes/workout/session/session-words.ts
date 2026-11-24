/**
 * What the session page and /workout's "What kind" step say (Instrument v2, Paper 4 · Train
 * "Logging off the plan"), pure. Apart from session-log.ts on purpose: /workout's empty page
 * (EmptyWorkout.svelte) is in every workout page's first paint and reads KIND_CHOICES, so these
 * words carry no mutation builder and none of the vocabulary's tables.
 */
import type { CustomMetric } from '#lib/domain/training/types.ts';
import type { OtherSessionKind } from '#lib/domain/training/vocabulary.ts';

/** The "What kind" list, in Paper's order and words. */
export const KIND_CHOICES: readonly { value: OtherSessionKind; label: string }[] = [
	{ value: 'class', label: 'Class' },
	{ value: 'pad_work', label: 'Pad work' },
	{ value: 'sparring', label: 'Sparring' },
	{ value: 'technical', label: 'Technical' },
	{ value: 'conditioning', label: 'Conditioning' },
	{ value: 'mobility', label: 'Mobility' },
	{ value: 'strength_conditioning', label: 'Strength and conditioning' },
	{ value: 'custom', label: 'Something else' }
];

/** An effort in a word: 1–3 Easy, 4–6 Moderate, 7–8 Hard, 9 Very hard, 10 All out. */
export function effortWord(rpe: number): string {
	if (rpe >= 10) return 'All out';
	if (rpe >= 9) return 'Very hard';
	if (rpe >= 7) return 'Hard';
	if (rpe >= 4) return 'Moderate';
	return 'Easy';
}

/** The sentence under the effort scale. */
export const effortSentence = (rpe: number | null): string =>
	rpe === null
		? 'Tap a number. 1 is easy, 10 is all out.'
		: `${rpe} is ${effortWord(rpe).toLowerCase()}. It shows as ${effortWord(rpe)} on the session.`;

/** More to keep's value: the metrics' names, the first capitalised ('Rounds, clinch'), or 'Add'. */
export function keptSummary(metrics: readonly CustomMetric[]): string {
	if (metrics.length === 0) return 'Add';
	return metrics
		.map((m, i) => (i === 0 ? m.label : m.label.charAt(0).toLowerCase() + m.label.slice(1)))
		.join(', ');
}

/** A metric's value in its row: '5', '120.5 kcal', 'Yes', 'No', the text, or 'Add'. */
export function metricValue(m: CustomMetric): string {
	if (typeof m.value === 'boolean') return m.value ? 'Yes' : 'No';
	if (typeof m.value === 'number') return m.unit ? `${m.value} ${m.unit}` : String(m.value);
	return m.value.trim() || 'Add';
}

/** The Notes row's value. */
export const notesValue = (notes: string | null): string => (notes?.trim() ? 'Edit' : 'Add');

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
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

/** The device's calendar day at `ms`, as a comparable key. */
const dayKey = (ms: number) => {
	const d = new Date(ms);
	return d.getFullYear() * 10_000 + d.getMonth() * 100 + d.getDate();
};

/**
 * The line under an own session's title, by the device's calendar: 'Today · your own session',
 * 'Yesterday · …', or its date ('Monday 16 November · …').
 */
export function ownSessionLine(startedAt: string, now: number): string {
	const started = Date.parse(startedAt);
	const day = dayKey(started);
	const yesterday = new Date(now);
	yesterday.setDate(yesterday.getDate() - 1);
	const d = new Date(started);
	const words =
		day === dayKey(now)
			? 'Today'
			: day === dayKey(yesterday.getTime())
				? 'Yesterday'
				: `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
	return `${words} · your own session`;
}
