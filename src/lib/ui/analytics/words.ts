/**
 * The words of a metric at a glance (M6 trend tiles), shared by TrendTile, VerdictBadge and the
 * specs, so a tile's visible parts and the one sentence a screen reader hears never disagree.
 * Pure and client-safe: it imports only types and the calendar.
 *
 * The server sends every number already formatted in the owner's units (`value`, `delta.text`,
 * the so-far values); this module only arranges them into words, picks each part's tone and
 * icon, and never computes a figure.
 */
import { weekdayOf, type IsoDate } from '#lib/domain/calendar.ts';
import type { Change, MetricKind } from '#lib/domain/analytics/types.ts';
import { WEEKDAY_INFO } from '#lib/domain/profile/catalog.ts';
import type { IconName } from '../icons/icons.ts';
import type { Sparkline } from './sparkline.ts';

export type Tone = 'neutral' | 'positive' | 'warning';

export const KIND_WORD: Readonly<Record<MetricKind, string>> = {
	measured: 'Measured',
	estimated: 'Estimated',
	calculated: 'Calculated',
	reported: 'Reported'
};

/** A change against the previous period, its number formatted by the server ('+5 kg'). */
export interface TileDelta {
	/** The signed difference in canonical units: it picks the icon. */
	value: number;
	text: string;
	/** better or worse by the metric's direction; up, down or same when neither is better. */
	change: Change;
	/** The previous period, named: 'the 12 weeks before'. */
	against: string;
}

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

/** The week in progress against the same days of last week, each formatted ('6,200 kg'). */
export interface TileSoFar {
	value: string | null;
	lastWeek: string | null;
	/** Today: its weekday names the days compared ('by Wednesday last week'). */
	through: IsoDate;
}

export interface Tile {
	label: string;
	/** The value formatted for the owner; null: no data yet. */
	value: string | null;
	unit?: string;
	/** The canonical number behind `value` (kg, metres, seconds, s/km…), for data-value. */
	canonical: number | null;
	kind: MetricKind;
	/** Null when there is no earlier period to compare with ('all', or nothing logged then). */
	delta: TileDelta | null;
	soFar?: TileSoFar | null;
	verdict?: TileVerdict | null;
	window?: VerdictWindow;
	sparkline?: Sparkline | null;
}

/** What a tile says with no earlier period to set its value against. */
export const NO_COMPARISON = 'No earlier period to compare with';

/** How a delta's number is set against the previous period: '+5 kg better than …'. */
export const CHANGE_WORDS: Readonly<Record<Change, string>> = {
	better: 'better than',
	worse: 'worse than',
	up: 'higher than',
	down: 'lower than',
	same: 'the same as'
};

/** The value with its unit, as read aloud: '142.5 kg', '5:42 /km'. */
export const valueWords = (value: string, unit?: string) => (unit ? `${value} ${unit}` : value);

/** '+5 kg better than the 12 weeks before'. */
export const deltaWords = (delta: TileDelta) =>
	`${delta.text} ${CHANGE_WORDS[delta.change]} ${delta.against}`;

/** The delta's icon: the way the number moved, whichever way is better. */
export const deltaIcon = (delta: TileDelta): IconName =>
	delta.value > 0 ? 'trend-up' : delta.value < 0 ? 'trend-down' : 'trend-flat';

/**
 * The delta's tone, by direction × good: better is positive, worse a warning, and a metric with
 * no better way neutral. A change the trend calls normal variation is neutral whatever its sign,
 * so noise never looks like news.
 */
export function deltaTone(delta: TileDelta, verdict?: TileVerdict | null): Tone {
	if (verdict?.verdict === 'normal_variation') return 'neutral';
	return delta.change === 'better' ? 'positive' : delta.change === 'worse' ? 'warning' : 'neutral';
}

/** 'This week so far: 6,200 kg · 5,900 kg by Wednesday last week'. */
export function soFarWords(soFar: TileSoFar): string {
	const day = WEEKDAY_INFO[weekdayOf(soFar.through)].label;
	return `This week so far: ${soFar.value ?? 'nothing yet'} · ${soFar.lastWeek ?? 'nothing'} by ${day} last week`;
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

export function verdictIcon(verdict: TileVerdict): IconName {
	if (verdict.verdict === 'real_trend') return `trend-${verdict.direction}`;
	return verdict.verdict === 'normal_variation' ? 'trend-flat' : 'clock';
}

export function verdictTone(verdict: TileVerdict): Tone {
	if (verdict.verdict !== 'real_trend' || verdict.good === null) return 'neutral';
	return verdict.good ? 'positive' : 'warning';
}

/**
 * The tile as one sentence, what a screen reader hears in place of its parts: 'Squat e1RM:
 * 142.5 kg, estimated. +5 kg better than the 12 weeks before. This week so far: … Real
 * improvement over the last 12 weeks.' With no value, Stat's contract: 'no data yet', never a
 * number; a week so far still reads, since a first week has one before any complete period.
 */
export function tileSentence(tile: Tile): string {
	if (tile.value === null) {
		const soFar = tile.soFar ? ` ${soFarWords(tile.soFar)}.` : '';
		const verdict = tile.verdict ? ` ${verdictWords(tile.verdict, tile.window)}.` : '';
		return `${tile.label}: no data yet.${soFar}${verdict}`;
	}
	const parts = [
		`${tile.label}: ${valueWords(tile.value, tile.unit)}, ${KIND_WORD[tile.kind].toLowerCase()}`,
		tile.delta ? deltaWords(tile.delta) : NO_COMPARISON,
		...(tile.soFar ? [soFarWords(tile.soFar)] : []),
		...(tile.verdict ? [verdictWords(tile.verdict, tile.window)] : [])
	];
	return parts.map((part) => `${part}.`).join(' ');
}
