/**
 * The season as Train's plan sheet lays it over M3's timeline (m7/39 periodisation-timeline):
 * each block from this one on with its phase tone, a lane per goal saying its role, its deload,
 * taper and recovery weeks, and the events and today along the whole road. Like timeline.ts, it
 * reads calendar strings, never the device's clock, and is composed on the server (Train's road
 * read), so the sheet carries none of the vocabulary. The road it reads is the periodisation road
 * (services/periodisation/road-view.ts), declared here as far as this reads it: UI declares its
 * own prop types.
 *
 * How BlockTimeline lists a block's weeks under the season is week-rows.ts's, apart, so the lazy
 * sheet loads none of this vocabulary.
 */
import { addDays, daysBetween, type IsoDate } from '#lib/domain/calendar.ts';
import { shortDate } from './words.ts';

/** A goal's role in a block, as the road names it. */
export type SeasonMode = 'primary' | 'secondary' | 'maintenance';

/** The periodisation road, as far as the season reads it. */
export interface SeasonRoad {
	blocks: readonly {
		phase: string;
		label: string;
		startsOn: IsoDate;
		endsOn: IsoDate;
		outline: boolean;
		weeks: readonly { startsOn: IsoDate; kind: string }[];
		goals: readonly { title: string; mode: SeasonMode }[];
		modesNote: string | null;
	}[];
	events: readonly { goalTitle: string; date: IsoDate }[];
	markers: readonly { week: IsoDate; kind: string }[];
}

/** A phase's tone: the colour beside its name, never in place of it. */
export type SeasonTone = 'build' | 'peak' | 'taper' | 'recovery' | 'maintenance' | 'bridge';

/** Decision (m7/39): the phases that are not building blocks; every other phase builds. */
export const PHASE_TONE: Readonly<Record<string, SeasonTone>> = {
	realization: 'peak',
	marathon_peak: 'peak',
	half_peak: 'peak',
	taper: 'taper',
	marathon_taper: 'taper',
	half_taper: 'taper',
	deload: 'recovery',
	recovery: 'recovery',
	maintenance: 'maintenance',
	transition: 'bridge'
};

/** A goal's role in words: 'Marathon · secondary'. */
export const MODE_WORDS: Readonly<Record<SeasonMode, string>> = {
	primary: 'leads',
	secondary: 'secondary',
	maintenance: 'maintenance'
};

/** The week kinds that carry a tick on their row, in words. */
export const TICK_WORDS: Readonly<Record<string, string>> = {
	deload: 'Deload',
	taper: 'Taper',
	recovery: 'Recovery'
};

export interface SeasonLane {
	goal: string;
	/** MODE_WORDS': 'leads', 'secondary' or 'maintenance'. */
	role: string;
	/** The block's leader (left out otherwise, a byte saved per lane). */
	lead?: true;
}

export interface SeasonBlock {
	/** Its first day: the TimelineBlock it lies over. */
	key: IsoDate;
	label: string;
	tone: SeasonTone;
	/** Its length in weeks, the track's segment width. */
	weeks: number;
	outline: boolean;
	/** The leader first; none in a bridge. */
	lanes: SeasonLane[];
	/** Its weeks' ticks, by the week's place in the block from 0: { 3: 'Deload' }. */
	ticks: Record<number, string>;
}

/** A mark on the track, in % of the road's days: an event, a ticked week, or today. */
export interface SeasonMark {
	at: number;
	kind: 'pin' | 'tick' | 'now';
}

export interface SeasonView {
	blocks: SeasonBlock[];
	/** For a program built before M7: its roles were worked out from its goals; else null. */
	note: string | null;
	/** The track's legend: its events, '◆ Muay Thai fight · Sat 16 Jan ◆ Marathon · Sun 25 Apr'. */
	legend: string;
	/** The track's marks: each event, each ticked week, then today when a block holds it. */
	marks: SeasonMark[];
}

const weeksIn = (from: IsoDate, to: IsoDate) => Math.round((daysBetween(from, to) + 1) / 7);

/** The season from `road`, as of `today`; null when the road holds no block. */
export function seasonView(road: SeasonRoad, today: IsoDate): SeasonView | null {
	const first = road.blocks[0];
	if (!first) return null;
	const start = first.startsOn;
	const days = daysBetween(start, road.blocks.at(-1)!.endsOn) + 1;
	const at = (date: IsoDate, offset = 0) =>
		Math.round(((daysBetween(start, date) + offset) / days) * 1000) / 10;

	const blocks = road.blocks.map((b): SeasonBlock => {
		const ticks: Record<number, string> = {};
		const mark = (monday: IsoDate, word: string | undefined) => {
			const i = daysBetween(b.startsOn, monday) / 7;
			if (word && i >= 0 && monday <= b.endsOn) ticks[i] ??= word;
		};
		b.weeks.forEach((w) => mark(w.startsOn, TICK_WORDS[w.kind]));
		// An outline's weeks are not planned yet: its taper is the road's marker, its recovery the block.
		if (b.outline) {
			road.markers.forEach((m) => mark(m.week, TICK_WORDS[m.kind]));
			if (PHASE_TONE[b.phase] === 'recovery') mark(b.startsOn, TICK_WORDS.recovery);
		}
		return {
			key: b.startsOn,
			label: b.label,
			tone: PHASE_TONE[b.phase] ?? 'build',
			weeks: weeksIn(b.startsOn, b.endsOn),
			outline: b.outline,
			lanes: b.goals.map((g) => ({
				goal: g.title,
				role: MODE_WORDS[g.mode],
				...(g.mode === 'primary' && { lead: true })
			})),
			ticks
		};
	});

	const end = road.blocks.at(-1)!.endsOn;
	const events = road.events.filter((e) => start <= e.date && e.date <= end);
	const ticks = blocks.flatMap((b) =>
		Object.keys(b.ticks).map((i) => ({ at: at(addDays(b.key, 7 * Number(i)), 3.5), kind: 'tick' }))
	);
	const now = start <= today && today <= end ? [{ at: at(today, 0.5), kind: 'now' }] : [];
	return {
		blocks,
		note: road.blocks.find((b) => b.modesNote)?.modesNote ?? null,
		legend: events.map((e) => `◆ ${e.goalTitle} · ${shortDate(e.date)}`).join(' '),
		marks: [
			...events.map((e) => ({ at: at(e.date, 0.5), kind: 'pin' })),
			...ticks,
			...now
		] as SeasonMark[]
	};
}
