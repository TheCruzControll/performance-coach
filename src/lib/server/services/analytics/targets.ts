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
 */
import type { GroupRange, GroupTargets } from '../../../domain/analytics/strength';
import { addDays, mondayOf, type IsoDate } from '../../../domain/calendar';
import type { ProgrammingInput } from '../../../domain/programming/input';
import { HARD_SET_RANGES, MAJOR_GROUPS } from '../../../domain/programming/rules/volume';
import type { StyleKey } from '../../../domain/programming/rules/strength';
import { chooseSplit, type Split } from '../../../domain/programming/splits';
import { hardSetBand } from '../../../domain/programming/volume';
import {
	exerciseRefKey,
	plannedHardSets,
	type ExerciseMuscles,
	type WeekHardSets
} from '../../../domain/training/metrics';
import type { ExerciseRef, WeekPlan } from '../../../domain/training/types';
import { cleanFloat } from '../../../domain/units';
import { createAnalyticsRepository } from '../../db/repositories/analytics';
import type { Executor } from '../../db/types';
import { measure } from '../../observability/timing';
import { getExercisesByIds, resolveKeys } from '../exercises/index';
import { programmingInputFor } from '../programs/alternatives';
import { getProgramVersion, type StoredWeek } from '../programs/index';
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
		type Placed = { programId: string; lineage: string; week: StoredWeek; input: unknown };
		const placed = new Map<IsoDate, Placed>();
		for (const program of await repo.programsInRange(ownerId, from, to)) {
			const version = await getProgramVersion(ownerId, program.id, program.versionNumber, { db });
			const inputs = await repo.blockInputs(program.id);
			for (const block of version.blocks.filter((b) => !b.outline)) {
				for (const week of block.weeks.filter((w) => w.endsOn >= from && w.startsOn <= to)) {
					const input = inputs.get(block.lineage) ?? null;
					placed.set(week.startsOn, { programId: program.id, lineage: block.lineage, week, input });
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
