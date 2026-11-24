/**
 * Profile → About this app → Speed (Paper, 9 · Profile, "Speed"): the p75 web vitals of the last
 * 7 days as three plain questions. How long opening the app took (LCP, on the start route when
 * there were launches), how quickly a tap was answered (INP), and whether things stayed put (CLS).
 * TTFB and FCP are still recorded, and not shown. Pure: the page draws these words.
 */
import type { VitalSummary } from '#lib/domain/vitals.ts';

export type Rating = 'good' | 'needs work' | 'poor';

/** Core Web Vitals thresholds (good, then poor above the second), https://web.dev/articles/vitals */
const LIMITS = { LCP: [2500, 4000], INP: [200, 500], CLS: [0.1, 0.25] } as const;

export const rate = (name: keyof typeof LIMITS, v: number): Rating =>
	v <= LIMITS[name][0] ? 'good' : v <= LIMITS[name][1] ? 'needs work' : 'poor';

/** "40 ms", "1.2 s". No Intl here: formatter construction is measurable hydration cost on phones. */
export function duration(ms: number): string {
	const rounded = Math.round(ms);
	return rounded < 1000 ? `${rounded} ms` : `${(ms / 1000).toFixed(1)} s`;
}

export interface SpeedRow {
	key: 'open' | 'tap' | 'stable';
	title: string;
	value: string;
}

const NOT_MEASURED = 'Not measured yet';
const ORDER: readonly Rating[] = ['good', 'needs work', 'poor'];

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const find = (vitals: VitalSummary[] | null, name: VitalSummary['name']) =>
	vitals?.find((v) => v.name === name);

/** Each question's p75 and its rating, or undefined when that vital has no samples. */
function measured(vitals: VitalSummary[] | null) {
	const lcp = find(vitals, 'LCP');
	const inp = find(vitals, 'INP');
	const cls = find(vitals, 'CLS');
	// Opening the app is a launch where there were some (the start route), else any page load.
	const open = lcp ? (lcp.start?.p75 ?? lcp.p75) : undefined;
	return {
		open: open === undefined ? undefined : { p: open, rating: rate('LCP', open) },
		tap: inp ? { p: inp.p75, rating: rate('INP', inp.p75) } : undefined,
		stable: cls ? { p: cls.p75, rating: rate('CLS', cls.p75) } : undefined
	};
}

/** The three rows: '1.2 s, good', '40 ms, good', 'Good'; 'Not measured yet' for one missing. */
export function speedRows(vitals: VitalSummary[] | null): SpeedRow[] {
	const { open, tap, stable } = measured(vitals);
	return [
		{
			key: 'open',
			title: 'Opening the app',
			value: open ? `${duration(open.p)}, ${open.rating}` : NOT_MEASURED
		},
		{
			key: 'tap',
			title: 'Answering a tap',
			value: tap ? `${duration(tap.p)}, ${tap.rating}` : NOT_MEASURED
		},
		{
			key: 'stable',
			title: 'Things staying put',
			value: stable ? capitalise(stable.rating) : NOT_MEASURED
		}
	];
}

/** About's row: the worst of the three ratings ("Good", "Needs work", "Poor"); none unmeasured. */
export function speedAnswer(vitals: VitalSummary[] | null): string | undefined {
	const ratings = Object.values(measured(vitals)).flatMap((m) => (m ? [m.rating] : []));
	if (!ratings.length) return undefined;
	return capitalise(ORDER[Math.max(...ratings.map((r) => ORDER.indexOf(r)))]!);
}

/** The line under the rows: how many launches (or visits) the numbers come from. */
export function speedNote(vitals: VitalSummary[] | null): string {
	const lcp = find(vitals, 'LCP');
	const launches = lcp?.start?.samples ?? 0;
	if (launches) return `From ${launches} ${launches === 1 ? 'launch' : 'launches'}.`;
	const visits = lcp?.samples ?? 0;
	if (visits) return `From ${visits} ${visits === 1 ? 'visit' : 'visits'}.`;
	return 'Nothing measured yet. It shows here once you’ve used the app for a while.';
}
