/**
 * The hypertrophy block as numbers (m7-plan hypertrophy-blocks; PRD §5): where each week's hard
 * sets per major muscle group start, how fast they rise, where they stop, how far the deload
 * drops them, and the rep ranges and RPE ramp the sets are done at. periodisation/hypertrophy.ts
 * applies them. Every number is a coaching default: changing one is a one-line edit here, and
 * each entry carries its why.
 */
import type { ExperienceLevel } from '../../profile/catalog.ts';

/** A hypertrophy exercise's kind, as HYPERTROPHY.reps names it. */
export type HypertrophyExerciseKind = 'compound' | 'isolation' | 'small';

/** The hypertrophy rules, one entry per rule key (rules/registry/hypertrophy.ts). */
export const HYPERTROPHY = {
	/**
	 * The first week sits at the low end of the split's hard-set band (volume.ts hardSetBand, which
	 * reads HARD_SET_RANGES.hypertrophy [10, 20] live); a cut starts at `keep` of it.
	 */
	start: {
		why: 'Starting at the least volume that still builds muscle leaves the whole range to grow into.'
	},
	/**
	 * Each week's range is `width` sets wide ([10, 12], then [12, 14]); its floor rises by `sets`
	 * at the lifter's level, `climb` on a bulk, and never by more than `maxShare` of the week
	 * before (rounded down).
	 */
	step: {
		sets: { new: 1, novice: 1, intermediate: 2, advanced: 2 } satisfies Record<
			ExperienceLevel,
			number
		>,
		climb: 2,
		maxShare: 0.2,
		width: 2,
		why: 'One or two sets a week, never a fifth more, is a rise recovery keeps up with; a surplus recovers faster, so a bulk climbs at the top step.'
	},
	/** No week goes above the band's top; on a cut, above `keep` of the top. */
	ceiling: {
		why: 'Past the top of the range more sets add fatigue faster than they add muscle.'
	},
	/** The deload is this share of the first week's sets, at this RPE, loads eased. */
	deload: {
		share: 0.6,
		rpe: 6,
		loadStep: -0.1,
		runVolumeFactor: 0.7,
		why: 'About 40 % fewer sets than the block began with lets the accumulated fatigue clear, so the block’s growth shows.'
	},
	/** Rep ranges by exercise kind: compounds, isolations, and isolations for a small muscle. */
	reps: {
		compound: [6, 10],
		isolation: [10, 15],
		small: [12, 20],
		why: 'Heavier compounds work best in lower reps, single-joint work in moderate ones, and small muscles recover fast enough for high reps.'
	},
	/**
	 * The top set's RPE over the building weeks, spread evenly across a longer block; an
	 * isolation's last set goes `isolationLastSet` above it, to 9.5 in the last week.
	 */
	rpe: {
		ramp: [7, 8, 8.5, 9],
		isolationLastSet: 0.5,
		loadStep: 0.025,
		why: 'Effort rises as the block goes on, so the early weeks leave room to add sets and the last ones take sets close to failure, where isolations are safe to push.'
	},
	/** A block is `building` weeks of accumulation (default `usual`), then one deload. */
	block: {
		building: [4, 6],
		usual: 4,
		why: 'Four to six weeks of rising volume is as long as recovery keeps pace before a deload is needed.'
	},
	/**
	 * setsPerGroup holds for M3's MAJOR_GROUPS (rules/volume.ts), the groups M6 judges; arms and
	 * calves get their sets from the compounds and the split's accessories, as in M3.
	 */
	groups: {
		why: 'The big groups are where the volume is planned and judged; small muscles are trained by the same compounds and by accessories.'
	}
} as const satisfies Record<string, { why: string; [value: string]: unknown }>;
