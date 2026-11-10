/**
 * The words of a metric at a glance (M6 trend tiles), shared by TrendTile and the specs, so a
 * tile's visible parts and the one sentence a screen reader hears never disagree. A verdict's own
 * words (VerdictBadge) are in verdict-words.ts, re-exported here.
 * Pure and client-safe: it imports only types, the calendar and the weekday names.
 *
 * The server sends every number already formatted in the owner's units (`value`, `delta.text`,
 * the so-far values); this module only arranges them into words, picks each part's tone and
 * icon, and never computes a figure.
 */
import { weekdayOf, type IsoDate } from '#lib/domain/calendar.ts';
import type { Change, MetricKind } from '#lib/domain/analytics/types.ts';
import { WEEKDAY_INFO } from '#lib/domain/weekdays.ts';
import type { IconName } from '../icons/icons.ts';
import type { Sparkline } from './sparkline.ts';
import { verdictWords, type Tone, type TileVerdict, type VerdictWindow } from './verdict-words.ts';

export {
	verdictIcon,
	verdictTone,
	verdictWords,
	type Tone,
	type TileVerdict,
	type VerdictWindow
} from './verdict-words.ts';

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
