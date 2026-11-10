/**
 * The next block's dates (PRD §11; M6), whether its cycle review is early, on time or weeks late:
 * the block sequence stays contiguous, whole weeks from Monday, and an event's date never moves.
 *
 * - next is the day after the reviewed block ends. S, the start, is today's Monday ('this week',
 *   planning from today) or the Monday after ('next Monday'), never before next. While the reviewed
 *   block is still running, next is the only start offered.
 * - k = (S − next) ÷ 7. With k ≥ 1 the lived-through weeks [next, S − 1] become a planned bridge
 *   block: phase transition ('Between blocks'), k unplanned weeks, no sessions (m6-plan open
 *   question 'a late cycle review': the default is this bridge, decided here alone).
 * - An outline that leads to no event starts at S, and it and every later outline shift by k weeks,
 *   each keeping its length.
 * - Before an M2 event, the outline blocks before the event-aligned one (the block ending in the
 *   event's week) absorb the k weeks: the next block down to MIN_NEXT_BLOCK_WEEKS, then each
 *   following one down to MIN_OUTLINE_WEEKS, then below them. The event-aligned block keeps its
 *   dates, unless even that is too late, when it starts at S. lostWeeks counts the weeks that went
 *   past the minimums.
 * - With no outline left, the block is appended from S with the directed weeks.
 * - A block over MAX_NEXT_BLOCK_WEEKS is planned for that many; the rest stays outline.
 *
 * Pure and server-only at runtime, like all of domain/programming.
 */
import { addDays, daysBetween, mondayOf } from '../../calendar.ts';
import type { IsoDate } from '../../calendar.ts';
import type { Phase, WeekKind } from '../../training/vocabulary.ts';

/** When the next block starts (services/programming's starts, by the same names). */
export const NEXT_BLOCK_STARTS = ['this_week', 'next_monday'] as const;
export type NextBlockStart = (typeof NEXT_BLOCK_STARTS)[number];
/**
 * The start offered first (m6-plan open question 'this week or next Monday'): this week, which
 * leaves no gap when the block ended last Sunday.
 */
export const DEFAULT_NEXT_BLOCK_START: NextBlockStart = 'this_week';

/** An event build's next block is never shortened below this many weeks while weeks remain. */
export const MIN_NEXT_BLOCK_WEEKS = 3;
/** Nor any later block before the event below this many. */
export const MIN_OUTLINE_WEEKS = 1;
/**
 * The longest block one review plans (M5's NEXT_CYCLE_MAX_WEEKS). A longer outline block (M3 gives
 * a marathon's build every week left) is planned for its first this many weeks; the rest stays
 * outline, planned by the next review.
 */
export const MAX_NEXT_BLOCK_WEEKS = 16;

export const BRIDGE_PHASE: Phase = 'transition';
export const BRIDGE_WEEK_KIND: WeekKind = 'unplanned';

/** A program block as far as its dates go. */
export interface DatedBlock {
	phase: Phase;
	name: string;
	startsOn: IsoDate;
	endsOn: IsoDate;
	outline: boolean;
}

export interface NextBlockDatesInput {
	/** The current version's blocks, in order: planned, then outline. */
	blocks: readonly DatedBlock[];
	/** The reviewed block's index in blocks. */
	reviewedBlock: number;
	today: IsoDate;
	start: NextBlockStart;
	/** M2's event dates. */
	events: readonly IsoDate[];
	/** The directed weeks, for a block appended with no outline left. */
	weeks: number;
}

export interface NextBlockDates {
	bridge?: { startsOn: IsoDate; endsOn: IsoDate; weeks: number };
	/** The new block's dates, and the outline block it plans (as it was dated), or null when appended. */
	block: { startsOn: IsoDate; endsOn: IsoDate; weeks: number; outline: DatedBlock | null };
	/** Every outline block after the new one, dated as it now stands. */
	shifted: DatedBlock[];
	lostWeeks: number;
	/** The first day the new block may hold a session. */
	firstPlannedDay: IsoDate;
}

const weeksOf = (b: { startsOn: IsoDate; endsOn: IsoDate }) =>
	(daysBetween(b.startsOn, b.endsOn) + 1) / 7;
const sundayOf = (day: IsoDate) => addDays(mondayOf(day), 6);

/** The starts on offer: while the reviewed block runs, only the Monday after it. */
export function offeredStarts(reviewed: DatedBlock, today: IsoDate): readonly NextBlockStart[] {
	return today <= reviewed.endsOn ? ['next_monday'] : NEXT_BLOCK_STARTS;
}

/** Block lengths in weeks laid end to end from `from`. */
function lay(blocks: readonly DatedBlock[], lengths: readonly number[], from: IsoDate) {
	let at = from;
	return blocks.flatMap((b, i) => {
		const weeks = lengths[i]!;
		if (weeks <= 0) return [];
		const dated = { ...b, startsOn: at, endsOn: addDays(at, 7 * weeks - 1) };
		at = addDays(dated.endsOn, 1);
		return [dated];
	});
}

/** The next block's dates, the bridge before it and the outline after it. */
export function nextBlockDates(input: NextBlockDatesInput): NextBlockDates {
	const { blocks, today, events } = input;
	const reviewed = blocks[input.reviewedBlock];
	if (!reviewed) throw new RangeError('No reviewed block at that index');
	const next = addDays(reviewed.endsOn, 1);
	const thisMonday = mondayOf(today);
	let start = input.start === 'this_week' ? thisMonday : addDays(thisMonday, 7);
	let firstPlannedDay = input.start === 'this_week' ? today : start;
	// While the reviewed block runs, both starts fall before next, so next is the only one.
	if (start < next) [start, firstPlannedDay] = [next, next];
	const k = daysBetween(next, start) / 7;
	const bridge = k >= 1 ? { startsOn: next, endsOn: addDays(start, -1), weeks: k } : undefined;

	const outline = blocks.slice(input.reviewedBlock + 1).filter((b) => b.outline);
	const result = (laid: DatedBlock[], source: DatedBlock | null, lostWeeks = 0): NextBlockDates => {
		const [first, ...rest] = laid as [DatedBlock, ...DatedBlock[]];
		const weeks = Math.min(weeksOf(first), MAX_NEXT_BLOCK_WEEKS);
		const endsOn = addDays(first.startsOn, 7 * weeks - 1);
		const left = endsOn < first.endsOn ? [{ ...first, startsOn: addDays(endsOn, 1) }] : [];
		const block = { startsOn: first.startsOn, endsOn, weeks, outline: source };
		const shifted = [...left, ...rest];
		return { ...(bridge && { bridge }), block, shifted, lostWeeks, firstPlannedDay };
	};

	if (outline.length === 0) {
		const appended = {
			phase: reviewed.phase,
			name: '',
			startsOn: start,
			endsOn: start,
			outline: false
		};
		return result(lay([appended], [input.weeks], start), null);
	}
	const aligned = outline.findIndex(
		(b) => b.endsOn >= start && events.some((day) => sundayOf(day) === b.endsOn)
	);
	if (aligned === -1) return result(lay(outline, outline.map(weeksOf), start), outline[0]!);

	// Before an event: the blocks before the event-aligned one fit into the weeks left before it.
	const before = outline.slice(0, aligned);
	const event = outline[aligned]!;
	const room = daysBetween(start, event.startsOn) / 7;
	const lengths = before.map(weeksOf);
	// A block already shorter than its floor (a half's 2-week peak) is floored at its own length.
	const floors = before.map((b, i) =>
		Math.min(weeksOf(b), i === 0 ? MIN_NEXT_BLOCK_WEEKS : MIN_OUTLINE_WEEKS)
	);
	let excess = lengths.reduce((a, b) => a + b, 0) - Math.max(room, 0);
	for (const floor of [floors, floors.map(() => 0)]) {
		lengths.forEach((weeks, i) => {
			const cut = Math.min(excess, Math.max(0, weeks - floor[i]!));
			lengths[i] = weeks - cut;
			excess -= cut;
		});
	}
	const lostWeeks = Math.max(0, floors.reduce((a, b) => a + b, 0) - room);
	const eventFrom = room < 0 ? start : event.startsOn;
	const laid = [
		...lay(before, lengths, start),
		{ ...event, startsOn: eventFrom },
		...outline.slice(aligned + 1)
	];
	const source = before.find((_, i) => lengths[i]! > 0) ?? event;
	return result(laid, source, lostWeeks);
}
