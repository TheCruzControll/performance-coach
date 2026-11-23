/**
 * The hard-set range per major group each week of a block was planned to (m7r/06
 * periodised-targets), worked out again through the generator's own functions so a plan and its
 * review cannot disagree. M6's Strength view, weekly review and cycle review read it through
 * src/lib/server/services/analytics/targets.ts.
 * - blockBands: undefined for a block M6's rule judges (a generator before M7's, or an input
 *   prepare plans no season for: M3's weeks as they always read); null with no strength split (a
 *   fight-only camp, whose weeks store a dose no session trains); otherwise the volume stage's
 *   heldBand for the split and mode prepare gave the stages at the block's start, and the block's
 *   setsPerGroup ranges.
 * - weekBand: a full-volume week (VOLUME_WEEK_MIN) that stores setsPerGroup is judged by that
 *   range as it stands (scale 1), or by the held band when the block plans that one range and it
 *   is the held band's (a dosed week, cut as the held band is cut); any other week by the block's
 *   first range, or the held band without one, × its volume factor, as balancePhased balances it.
 */
import type { IsoDate } from '../calendar.ts';
import type { WeekTargets } from '../training/types.ts';
import type { Phase } from '../training/vocabulary.ts';
import { cleanFloat } from '../units.ts';
import { DecisionLog } from './decisions.ts';
import type { ProgrammingInput } from './input.ts';
import { VOLUME_WEEK_MIN } from './rules/volume.ts';
import { chooseSplit } from './splits.ts';
import { strengthMode } from './stages/phasing.ts';
import { prepare } from './stages/prepare.ts';
import { heldBand } from './stages/volume.ts';
import type { SetBand } from './volume.ts';

/**
 * The generators whose blocks M6's rule judges: M3's first and M6's next block before prepare
 * planned a season (m7r/02). Every later id is judged as the generator balanced it.
 */
export const PRE_M7_GENERATORS: readonly string[] = [
	'perfo-programming/1',
	'next-block/1',
	'next-block/1+perfo-programming/1'
];

/** The generated version that first planned a block: its input, generator and week 1 Monday. */
export interface BlockOrigin {
	input: ProgrammingInput;
	generator: string;
	startsOn: IsoDate;
}

/** What blockBands reads of a block: a stored block and a generated one both fit. */
export interface TargetBlock {
	startsOn: IsoDate;
	endsOn: IsoDate;
	phase: Phase;
	weeks: readonly { targets: WeekTargets }[];
}

/** Where a week's range comes from, for its label. */
export type BandSource = 'plan' | 'dose' | 'secondary' | 'profile';

export interface BlockBands {
	held: SetBand;
	/** Where the held band comes from: the strength goal's mode, or the maintenance split's dose. */
	heldSource: Exclude<BandSource, 'plan'>;
	/** The block's full-volume setsPerGroup ranges, in week order, each once. */
	ranges: readonly (readonly [number, number])[];
}

export interface WeekBand {
	/** Every major group's [lowest, highest] hard sets for the week. */
	range: [number, number];
	/** What the band was scaled by: 1 for a week judged by its own range, else its volume factor. */
	scale: number;
	source: BandSource;
	/** The band in words. */
	band: string;
}

const span = ([lo, hi]: readonly [number, number]) => (lo === hi ? `${lo}` : `${lo}–${hi}`);
const isFull = (targets: WeekTargets) => targets.volumeFactor >= VOLUME_WEEK_MIN;
const same = (a: readonly [number, number], b: readonly [number, number]) =>
	a[0] === b[0] && a[1] === b[1];

/**
 * The input the stages read when `origin` planned `block`, and whether prepare planned a season:
 * from the block's own start when it does not start on the version's week 1 Monday (a next block,
 * a re-plan's next block), else from that Monday, as generateProgram calls it; at the block's own
 * phase and last day in both cases, so a block chosen from the start is judged by its chosen phase.
 */
function preparedFor(origin: BlockOrigin, block: TargetBlock) {
	const own = block.startsOn !== origin.startsOn;
	const startsOn = own ? block.startsOn : origin.startsOn;
	const planned = { phase: block.phase, endsOn: block.endsOn };
	const options = { startsOn, firstPlannedDay: startsOn };
	return prepare(origin.input, options, new DecisionLog(), planned);
}

/** How `block`'s weeks are judged (see the header); undefined for M6's rule. */
export function blockBands(origin: BlockOrigin, block: TargetBlock): BlockBands | null | undefined {
	if (PRE_M7_GENERATORS.includes(origin.generator)) return undefined;
	const prepared = preparedFor(origin, block);
	if (!prepared.periodisation) return undefined;
	let split;
	try {
		split = chooseSplit(prepared.input, 1);
	} catch (error) {
		if (error instanceof RangeError) return null;
		throw error;
	}
	const held = heldBand(split, prepared.input);
	const mode = strengthMode(prepared.input);
	const heldSource =
		mode === 'secondary'
			? 'secondary'
			: split.maintenance || mode === 'maintenance'
				? 'dose'
				: 'profile';
	const ranges: [number, number][] = [];
	for (const { targets } of block.weeks) {
		const own = targets.setsPerGroup;
		if (!own || !isFull(targets)) continue;
		const range: [number, number] = [own.min, own.max];
		if (!ranges.some((r) => same(r, range))) ranges.push(range);
	}
	return { held, heldSource, ranges };
}

/** The held band at `scale`: its sets × keep × scale, in its words. */
function heldAt(bands: BlockBands, scale: number, source = bands.heldSource): WeekBand {
	const { sets, keep, band } = bands.held;
	const range = sets.map((n) => cleanFloat(n * keep * scale, 2)) as [number, number];
	return { range, scale, source, band };
}

/** Week `targets`' band in a block whose bands are `bands` (see the header). */
export function weekBand(targets: WeekTargets, bands: BlockBands): WeekBand {
	const own = targets.setsPerGroup;
	const ranged = own && isFull(targets) ? ([own.min, own.max] as const) : null;
	const base = ranged ?? bands.ranges[0] ?? null;
	const scale = ranged ? 1 : targets.volumeFactor;
	if (!base) return heldAt(bands, scale);
	const dosed = targets.maintenance?.some((s) => s === 'strength' || s === 'hypertrophy');
	// One range that is the held band's (a dosed week's): the held band, cut as it is cut.
	if (bands.ranges.length === 1 && same(base, bands.held.sets)) {
		return heldAt(bands, scale, dosed ? 'dose' : bands.heldSource);
	}
	const range = base.map((n) => cleanFloat(n * scale, 2)) as [number, number];
	const band = `the ${span(base)} this block plans for the week`;
	return { range, scale, source: dosed ? 'dose' : 'plan', band };
}
