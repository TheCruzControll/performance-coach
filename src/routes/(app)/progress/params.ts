/**
 * What /progress shows, read from its search parameters: the view (?view) and the period
 * (?period, periods.ts). Client-safe and pure: it imports only periods.ts, so +page.ts and the
 * page can read the same values the server loaded.
 *
 * Anything unknown (missing, misspelt, another case, an inherited key such as 'toString') is
 * refused and gives the default: the overview over DEFAULT_PERIOD (12 weeks). Each later view
 * (Strength, Running, General) adds one id here.
 */
import { DEFAULT_PERIOD, parsePeriod, type Period } from '#lib/domain/analytics/periods.ts';

export const PROGRESS_VIEWS = ['overview', 'strength', 'running', 'general'] as const;
export type ProgressView = (typeof PROGRESS_VIEWS)[number];

/** The view /progress opens on, and the one an unknown ?view falls back to. */
export const DEFAULT_VIEW: ProgressView = 'overview';

export const VIEW_LABEL: Readonly<Record<ProgressView, string>> = {
	overview: 'Overview',
	strength: 'Strength',
	running: 'Running',
	general: 'General'
};

export interface ProgressParams {
	view: ProgressView;
	period: Period;
}

/** The view a ?view value names; anything else is DEFAULT_VIEW. */
export function parseView(value: string | null | undefined): ProgressView {
	return PROGRESS_VIEWS.find((view) => view === value) ?? DEFAULT_VIEW;
}

/** The view and period `search` asks for, the first of a repeated parameter winning. */
export function progressParams(search: URLSearchParams): ProgressParams {
	return { view: parseView(search.get('view')), period: parsePeriod(search.get('period')) };
}

/** The query string of `params`, defaults left out: '' for the overview over 12 weeks. */
export function progressQuery({ view, period }: ProgressParams): string {
	const search = new URLSearchParams();
	if (view !== DEFAULT_VIEW) search.set('view', view);
	if (period !== DEFAULT_PERIOD) search.set('period', period);
	const query = search.toString();
	return query ? `?${query}` : '';
}
