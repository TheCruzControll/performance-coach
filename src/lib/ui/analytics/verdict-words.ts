/**
 * A trend verdict's words, icon and tone (VerdictBadge), apart from the rest of a tile's words
 * (words.ts, which re-exports them) so a screen that shows verdicts without tiles loads only
 * these: Progress's verdicts are in its initial JavaScript, its tiles load after hydration.
 * Pure and client-safe: it imports only types.
 */
import type { IconName } from '../icons/icons.ts';

export type Tone = 'neutral' | 'positive' | 'warning';

/** A trend verdict as a tile shows it (trend.ts's TrendResult, reduced to what is said). */
export type TileVerdict =
	| { verdict: 'real_trend'; direction: 'up' | 'down'; good: boolean | null }
	| { verdict: 'normal_variation' }
	| { verdict: 'insufficient_data'; have: number; need: number; unit: string };

/** The weeks a verdict reads (periods.ts's trendWindow): said only when not the period's own. */
export interface VerdictWindow {
	sameAsPeriod: boolean;
	weeks: number | null;
}

/**
 * 'Real improvement', 'Real decline', 'Normal variation' or 'Not enough data yet · 2 of 6 weeks',
 * with 'over the last 12 weeks' when the verdict reads other weeks than the period's. A real
 * trend in a metric with no better way is a 'Real rise' or a 'Real fall'.
 */
export function verdictWords(verdict: TileVerdict, window?: VerdictWindow): string {
	const over =
		window && !window.sameAsPeriod && window.weeks ? ` over the last ${window.weeks} weeks` : '';
	switch (verdict.verdict) {
		case 'real_trend': {
			const words =
				verdict.good === null
					? verdict.direction === 'up'
						? 'Real rise'
						: 'Real fall'
					: verdict.good
						? 'Real improvement'
						: 'Real decline';
			return words + over;
		}
		case 'normal_variation':
			return 'Normal variation' + over;
		case 'insufficient_data':
			return `Not enough data yet · ${verdict.have} of ${verdict.need} ${verdict.unit}` + over;
	}
}

/**
 * A real trend's arrow follows better, not the raw sign: a pace that fell (faster) is an
 * improvement and points up beside its 'Real improvement'. With no better way, the way it moved.
 */
export function verdictIcon(verdict: TileVerdict): IconName {
	if (verdict.verdict === 'real_trend') {
		if (verdict.good === null) return `trend-${verdict.direction}`;
		return verdict.good ? 'trend-up' : 'trend-down';
	}
	return verdict.verdict === 'normal_variation' ? 'trend-flat' : 'clock';
}

export function verdictTone(verdict: TileVerdict): Tone {
	if (verdict.verdict !== 'real_trend' || verdict.good === null) return 'neutral';
	return verdict.good ? 'positive' : 'warning';
}
