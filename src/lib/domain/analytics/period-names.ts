/**
 * The periods Progress offers, their labels and ?period parsing (periods.ts defines what each
 * period covers, and re-exports these). A screen's period switcher and its URL parsing import this
 * module rather than periods.ts, so the windows and the calendar they need stay out of a route's
 * initial JavaScript. Client-safe (scripts/analytics-client-imports.test.ts).
 */

/** The periods Progress offers, shortest first. */
export const PERIODS = ['4w', '12w', '26w', '52w', 'all'] as const;
export type Period = (typeof PERIODS)[number];

/** The period a screen opens on, and the one an unknown ?period value falls back to. */
export const DEFAULT_PERIOD: Period = '12w';

export const PERIOD_LABEL: Readonly<Record<Period, string>> = {
	'4w': 'Last 4 weeks',
	'12w': 'Last 12 weeks',
	'26w': 'Last 26 weeks',
	'52w': 'Last 52 weeks',
	all: 'All time'
};

/** The period a ?period value names; anything else (missing, misspelt, another case) is DEFAULT_PERIOD. */
export function parsePeriod(value: string | null | undefined): Period {
	return PERIODS.find((period) => period === value) ?? DEFAULT_PERIOD;
}
