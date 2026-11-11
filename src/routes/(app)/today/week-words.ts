/**
 * Today's 'This week' tiles in words (week.server.ts composes them on the server, so the page
 * ships only the empty tiles and the method's words): sessions, training load and distance from
 * Monday through today, and one line setting them against the same days of last week. Once
 * anything has been logged an empty week reads 0, never 'no data yet'; before the first session
 * every tile reads 'no data yet'.
 * A load stays unknown only when this week's sessions all lack minutes or an RPE: a number is
 * never invented (PRD §12), and the tile says what it needs instead of showing a bare dash.
 */
import type { SoFar } from '#lib/domain/analytics/series.ts';
import { weekdayOf, type IsoDate } from '#lib/domain/calendar.ts';
import type { ProfileDistanceUnit } from '#lib/domain/profile/types.ts';
import { fromMetres } from '#lib/domain/units.ts';
import { WEEKDAY_INFO } from '#lib/domain/weekdays.ts';

/** The figures the tiles show (services/analytics/week.ts's WeekSoFar, as the words need it). */
export interface WeekFigures {
	week: { through: IsoDate };
	units: { distance: ProfileDistanceUnit };
	logged: boolean;
	sessions: Pick<SoFar, 'value' | 'lastWeek'>;
	load: Pick<SoFar, 'value' | 'lastWeek'>;
	distance: Pick<SoFar, 'value' | 'lastWeek'>;
}

export interface WeekTile {
	id: 'sessions' | 'load' | 'distance';
	label: string;
	/** Null: no data yet. */
	value: string | null;
	unit?: string;
	/** Why a value is missing once sessions are logged. */
	caption?: string;
}

export type TodayWeekView =
	| { failed: true }
	| {
			failed: false;
			tiles: WeekTile[];
			/** 'By Wednesday last week: 2 sessions, training load 380, 8.2 km.' */
			against: string;
	  };

/** What training load is, for the tiles' disclosure. */
export const LOAD_METHOD =
	'Training load is each workout’s minutes × its session RPE (how hard it felt, out of 10), added up. A 60-minute session at RPE 7 adds 420. Each figure counts Monday to today and is set against the same days last week.';

export const NOTHING_YET = 'Your week fills in as you log sessions.';

const formats = new Map<number, Intl.NumberFormat>();
function number(value: number, decimals: number): string {
	let format = formats.get(decimals);
	if (!format) {
		format = new Intl.NumberFormat('en-US', { maximumFractionDigits: decimals });
		formats.set(decimals, format);
	}
	return format.format(value);
}

/** The tiles before anything is logged, or while their figures cannot be read. */
export const EMPTY_TILES: readonly WeekTile[] = [
	{ id: 'sessions', label: 'Sessions', value: null },
	{ id: 'load', label: 'Training load', value: null },
	{ id: 'distance', label: 'Distance', value: null }
];

export function weekView(figures: WeekFigures): Extract<TodayWeekView, { failed: false }> {
	if (!figures.logged) return { failed: false, tiles: [...EMPTY_TILES], against: NOTHING_YET };
	const unit = figures.units.distance;
	const sessions = (n: number | null) => number(n ?? 0, 0);
	const load = (n: number | null, count: number | null) =>
		n === null ? (count ? null : '0') : number(Math.round(n), 0);
	const distance = (metres: number | null) => number(fromMetres(metres ?? 0, unit), 1);

	const { sessions: s, load: l, distance: d } = figures;
	const known = load(l.value, s.value);
	const tiles: WeekTile[] = [
		{ id: 'sessions', label: 'Sessions', value: sessions(s.value) },
		known === null
			? { id: 'load', label: 'Training load', value: null, caption: 'Needs an RPE' }
			: { id: 'load', label: 'Training load', value: known },
		{ id: 'distance', label: 'Distance', value: distance(d.value), unit }
	];

	const day = WEEKDAY_INFO[weekdayOf(figures.week.through)].label;
	if (s.lastWeek === null && d.lastWeek === null) {
		return { failed: false, tiles, against: `Nothing logged by ${day} last week.` };
	}
	const count = s.lastWeek ?? 0;
	const before = load(l.lastWeek, s.lastWeek);
	const parts = [
		`${sessions(count)} ${count === 1 ? 'session' : 'sessions'}`,
		...(before === null ? [] : [`training load ${before}`]),
		`${distance(d.lastWeek)} ${unit}`
	];
	return { failed: false, tiles, against: `By ${day} last week: ${parts.join(', ')}.` };
}
