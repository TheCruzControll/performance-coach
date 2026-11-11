/**
 * Weekly hard-set targets per muscle group (PRD §5, §10): the one source the Strength view, the
 * weekly review and the cycle review read. A week stores only its volume factor, so each week's
 * range is worked out again from the input that generated its block:
 * - the input_snapshot of the lowest-numbered version of the program that has a generator and
 *   plans that block lineage (version 1 for M3's first blocks, the planning version for later
 *   ones), so changing today's goals or nutrition phase never rewrites a past week;
 * - the range is volume.ts's hardSetBand for the split that input chooses, for MAJOR_GROUPS only
 *   (a cut keeps `keep` of it), scaled by the week's volume factor: a 0.6 deload shows 6–12;
 * - the planned line is plannedHardSets of the week as the program's current version plans it.
 * A program with no stored input shows its planned line only (NO_STORED_TARGET); a week no program
 * plans takes today's profile style at full volume (defaultLabel).
 *
 * M7 weeks (m7-plan periodised-targets) are judged by the band the generator used (weekRange):
 * - only a block with a strength split (heldFor not null) is judged so; one without (a fight-only
 *   camp, whose weeks store a dose no session trains) shows NO_STRENGTH_TARGET, as in M6
 * - a full-volume week (VOLUME_WEEK_MIN) that stores its own setsPerGroup (a hypertrophy week's
 *   rising range, a dosed week's band) is judged by that [min, max], unscaled: its volume factor
 *   reads 1 (ownRangeLabel, or doseLabel when the week holds strength at its maintenance dose)
 * - any other week of a block with such weeks is judged by the block's first range × its volume
 *   factor, as balancePhased balances it (a fight week's stored 4–10 at 0.4 reads 1.6–4)
 * - a block a generator after generator-season built (not PRE_M7_GENERATORS) is judged by the
 *   volume stage's heldBand, which is doseBand(chooseSplit(prepared), phase, mode) for the input
 *   prepare gave the stages at the block's start: the generator's own split and band, the
 *   maintenance dose (doseLabel) and a secondary goal's lower half (secondaryLabel) included
 * - every other block is judged by M6's rule above, unchanged.
 */
import type { GroupRange, GroupTargets } from '../../../domain/analytics/strength';
import { addDays, mondayOf, type IsoDate } from '../../../domain/calendar';
import { DecisionLog } from '../../../domain/programming/decisions';
import type { ProgrammingInput } from '../../../domain/programming/input';
import {
	HARD_SET_RANGES,
	MAJOR_GROUPS,
	VOLUME_WEEK_MIN
} from '../../../domain/programming/rules/volume';
import type { StyleKey } from '../../../domain/programming/rules/strength';
import { chooseSplit, type Split } from '../../../domain/programming/splits';
import { strengthMode } from '../../../domain/programming/stages/phasing';
import { prepare } from '../../../domain/programming/stages/prepare';
import { heldBand } from '../../../domain/programming/stages/volume';
import { hardSetBand, type SetBand } from '../../../domain/programming/volume';
import {
	exerciseRefKey,
	plannedHardSets,
	type ExerciseMuscles,
	type WeekHardSets
} from '../../../domain/training/metrics';
import type { ExerciseRef, WeekPlan } from '../../../domain/training/types';
import { cleanFloat } from '../../../domain/units';
import { createAnalyticsRepository, type BlockInput } from '../../db/repositories/analytics';
import type { Executor } from '../../db/types';
import { measure } from '../../observability/timing';
import { getExercisesByIds, resolveKeys } from '../exercises/index';
import { programmingInputFor } from '../programs/alternatives';
import { getProgramVersion, type StoredBlock, type StoredWeek } from '../programs/index';
import { resolveDeps, type TrainingDeps } from '../training/shared';

/** Shown for a program no generator built: its planned line, and no range. */
export const NO_STORED_TARGET = 'No stored target for this program';
/** Shown for a block built from an input with no strength goal: nothing to hold a range for. */
export const NO_STRENGTH_TARGET = 'No strength goal when this block was planned';
/** Shown for a block judged by its stored input. */
export const STORED_TARGET = 'From the profile this block was planned with';
/** The style a week with no program takes when today's profile has no strength goal. */
export const DEFAULT_TARGET_STYLE: StyleKey = 'hypertrophy';
export const defaultLabel = (style: StyleKey) => `Default for ${style}`;

const span = ([lo, hi]: readonly [number, number]) => (lo === hi ? `${lo}` : `${lo}–${hi}`);
/** Shown for a week judged by the setsPerGroup it stores. */
export const ownRangeLabel = (range: readonly [number, number]) =>
	`From this block’s plan: ${span(range)} sets`;
/** Shown for a week that holds strength at its maintenance dose. */
export const doseLabel = (range: readonly [number, number]) =>
	`Maintenance dose: ${span(range)} sets`;
/** Shown for a week whose strength goal trains as a secondary goal. */
export const secondaryLabel = (range: readonly [number, number]) =>
	`Secondary goal: ${span(range)} sets`;

/**
 * The generators whose blocks M6's rule judges: M3's and M6's before M7's generator-season (and
 * M6's next block over that M3, m7-stage-list's byte-identical id) planned by goal priority.
 * Every later id is judged as the generator balanced it.
 */
export const PRE_M7_GENERATORS: readonly string[] = [
	'perfo-programming/1',
	'next-block/1',
	'next-block/1+perfo-programming/1'
];

export type TargetSource = 'block' | 'none' | 'default';

export interface WeekTarget {
	/** The week's Monday. */
	weekStart: IsoDate;
	source: TargetSource;
	label: string;
	/** The program and block that plan the week; null when none does. */
	programId: string | null;
	blockLineage: string | null;
	volumeFactor: number;
	/** Each major group's [lowest, highest] hard sets for the week; empty without a range. */
	targets: GroupTargets;
	/** The range in the words the volume_adjusted decision used; null without one. */
	band: string | null;
	/** The week's planned hard sets; null when no program plans it. */
	planned: WeekHardSets | null;
}

const GROUPS = Object.keys(MAJOR_GROUPS) as (keyof typeof MAJOR_GROUPS)[];

/** hardSetBand's range for `split` and phase, at `factor` of full volume, for every major group. */
function rangesOf(split: Split, phase: ProgrammingInput['nutritionPhase'], factor: number) {
	const { sets, keep, band } = hardSetBand(split, phase);
	const range = sets.map((n) => cleanFloat(n * keep * factor, 2)) as unknown as GroupRange;
	return { targets: Object.fromEntries(GROUPS.map((g) => [g, range])) as GroupTargets, band };
}

/**
 * The input the stages read when `origin` planned `block`: prepare's, at M6's next block's own
 * start and phase, or at M3's week 1 Monday, as each generator calls it.
 */
function preparedFor(origin: BlockInput, block: StoredBlock): ProgrammingInput {
	const input = origin.input as unknown as ProgrammingInput;
	const next = origin.generator.startsWith('next-block/');
	const startsOn = next ? block.startsOn : origin.startsOn;
	const planned = next ? { phase: block.phase, endsOn: block.endsOn } : undefined;
	const options = { startsOn, firstPlannedDay: startsOn };
	return prepare(input, options, new DecisionLog(), planned).input;
}

/** How an M7 block's weeks without their own range are judged; null with no strength goal. */
interface Held {
	held: SetBand;
	/** The block's first full-volume setsPerGroup, which its lighter weeks scale; null without. */
	first: readonly [number, number] | null;
	label: (range: readonly [number, number]) => string;
}

/** The volume stage's band for an M7 block, and the words for where it came from. */
function heldFor(origin: BlockInput, block: StoredBlock): Held | null {
	const prepared = preparedFor(origin, block);
	const split = splitOf(prepared);
	if (!split) return null;
	const held = heldBand(split, prepared);
	const mode = strengthMode(prepared);
	const label =
		mode === 'secondary'
			? secondaryLabel
			: split.maintenance || mode === 'maintenance'
				? doseLabel
				: () => STORED_TARGET;
	const full = block.weeks.find((w) => w.targets.setsPerGroup && isFull(w))?.targets.setsPerGroup;
	return { held, label, first: full ? [full.min, full.max] : null };
}

/** A week balanced to its own setsPerGroup, as balancePhased's `ranged` reads it. */
const isFull = (week: StoredWeek) => week.targets.volumeFactor >= VOLUME_WEEK_MIN;

/**
 * Week `week`'s range, for a block an M7 generator built with a strength split (see
 * the header); null for M6's rule. `held` is heldFor's, for the week's block.
 */
function weekRange(week: StoredWeek, held: Held | null | undefined) {
	if (!held) return null;
	const own = week.targets.setsPerGroup;
	const factor = week.targets.volumeFactor;
	const ranged = own && isFull(week) ? ([own.min, own.max] as const) : null;
	const base = ranged ?? held.first;
	if (base) {
		const scale = ranged ? 1 : factor;
		const range = base.map((n) => cleanFloat(n * scale, 2)) as [number, number];
		const dosed = week.targets.maintenance?.some((s) => s === 'strength' || s === 'hypertrophy');
		const label = dosed ? doseLabel(range) : ownRangeLabel(range);
		const band = `the ${span(range)} this block plans for the week`;
		return { label, volumeFactor: scale, band, targets: groupsAt(range as unknown as GroupRange) };
	}
	const { sets, keep, band } = held.held;
	const range = sets.map((n) => cleanFloat(n * keep * factor, 2)) as unknown as GroupRange;
	const label = held.label(range as unknown as [number, number]);
	return { label, volumeFactor: factor, band, targets: groupsAt(range) };
}

const groupsAt = (range: GroupRange) =>
	Object.fromEntries(GROUPS.map((g) => [g, range])) as GroupTargets;

/** The split an input chooses; null when it has no strength goal (chooseSplit's RangeError). */
function splitOf(input: ProgrammingInput): Split | null {
	try {
		return chooseSplit(input, 1);
	} catch (error) {
		if (error instanceof RangeError) return null;
		throw error;
	}
}

/** The muscles of every exercise the weeks plan, by exerciseRefKey. */
async function musclesOf(ownerId: string, weeks: readonly StoredWeek[], db: Executor) {
	const refs: ExerciseRef[] = weeks.flatMap((w) =>
		w.sessions.flatMap((s) => (s.kind === 'strength' ? s.exercises.map((e) => e.exercise) : []))
	);
	const keys = refs.flatMap((ref) => ('key' in ref ? [ref.key] : []));
	const custom = refs.flatMap((ref) => ('customId' in ref ? [ref.customId] : []));
	const muscles = new Map<string, ExerciseMuscles>();
	for (const [key, def] of await resolveKeys(keys, { db })) muscles.set(key, def);
	for (const [id, def] of await getExercisesByIds(ownerId, custom, { db }))
		muscles.set(exerciseRefKey({ customId: id }), def);
	return muscles;
}

/** Each week's targets from `from`'s Monday to `to`, both included, oldest first. */
export async function getMuscleTargets(
	ownerId: string,
	{ from, to }: { from: IsoDate; to: IsoDate },
	deps: TrainingDeps = {}
): Promise<WeekTarget[]> {
	const { db } = resolveDeps(deps);
	return measure('analytics', async () => {
		const repo = createAnalyticsRepository(db);
		type Placed = {
			programId: string;
			lineage: string;
			week: StoredWeek;
			input: unknown;
			/** An M7 block's band (undefined for M6's rule; null with no strength goal). */
			held: Held | null | undefined;
		};
		const placed = new Map<IsoDate, Placed>();
		for (const program of await repo.programsInRange(ownerId, from, to)) {
			const version = await getProgramVersion(ownerId, program.id, program.versionNumber, { db });
			const inputs = await repo.blockInputs(program.id);
			for (const block of version.blocks.filter((b) => !b.outline)) {
				const weeks = block.weeks.filter((w) => w.endsOn >= from && w.startsOn <= to);
				const origin = inputs.get(block.lineage);
				const m7 = origin && !PRE_M7_GENERATORS.includes(origin.generator);
				const held = m7 && weeks.length ? heldFor(origin, block) : undefined;
				for (const week of weeks) {
					const input = origin?.input ?? null;
					const at = { programId: program.id, lineage: block.lineage, week, input, held };
					placed.set(week.startsOn, at);
				}
			}
		}
		const muscles = await musclesOf(
			ownerId,
			[...placed.values()].map((p) => p.week),
			db
		);

		// Today's profile style, read once and only when a week has no program.
		let todays: Promise<StyleKey> | undefined;
		const styleToday = async () => {
			const split = splitOf(await programmingInputFor(ownerId, { db }));
			return split ? hardSetBand(split, null).style : DEFAULT_TARGET_STYLE;
		};
		const weeks: WeekTarget[] = [];
		for (let weekStart = mondayOf(from); weekStart <= to; weekStart = addDays(weekStart, 7)) {
			const at = placed.get(weekStart);
			if (!at) {
				const style = await (todays ??= styleToday());
				const range = HARD_SET_RANGES[style].sets;
				weeks.push({
					...{ weekStart, source: 'default', label: defaultLabel(style), volumeFactor: 1 },
					...{ programId: null, blockLineage: null, band: null, planned: null },
					targets: Object.fromEntries(GROUPS.map((g) => [g, range]))
				});
				continue;
			}
			const volumeFactor = at.week.targets.volumeFactor;
			const planned = plannedHardSets(at.week as unknown as WeekPlan, muscles);
			const place = { weekStart, programId: at.programId, blockLineage: at.lineage, volumeFactor };
			const m7 = weekRange(at.week, at.held);
			if (m7) {
				weeks.push({ ...place, source: 'block', ...m7, planned });
				continue;
			}
			const input = at.input as ProgrammingInput | null;
			const split = input && splitOf(input);
			if (!input || !split) {
				const label = input ? NO_STRENGTH_TARGET : NO_STORED_TARGET;
				weeks.push({ ...place, source: 'none', label, targets: {}, band: null, planned });
				continue;
			}
			const ranges = rangesOf(split, input.nutritionPhase, volumeFactor);
			weeks.push({ ...place, source: 'block', label: STORED_TARGET, ...ranges, planned });
		}
		return weeks;
	});
}
