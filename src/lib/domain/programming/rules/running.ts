/**
 * The concurrent-training numbers (PRD §5; m3-plan 'Not told yet' defaults): fixed commitments.
 * commitments.ts applies them, and each number lives here and nowhere else, so changing one is a
 * one-line edit.
 */
import type { Discipline, Intensity } from '../../profile/catalog.ts';
import type { RunSegment } from '../../training/types.ts';
import type { RunSegmentKind, SessionType } from '../../training/vocabulary.ts';

type HrZone = NonNullable<RunSegment['hrZone']>;

// ---- Commitments ----------------------------------------------------------------------------

/** A commitment's target RPE by its intensity, moderate when the owner gave none. */
export const COMMITMENT_RPE: Readonly<Record<Intensity, number>> = {
	light: 4,
	moderate: 6,
	hard: 8
};

/**
 * A running commitment is one timed segment: the club sets the pace, and its intensity sets the
 * effort, the heart-rate zone and the session type.
 */
export const COMMITMENT_RUN: Readonly<
	Record<Intensity, { type: SessionType; segment: RunSegmentKind; hrZone: HrZone }>
> = {
	light: { type: 'easy_run', segment: 'easy', hrZone: 2 },
	moderate: { type: 'easy_run', segment: 'steady', hrZone: 3 },
	hard: { type: 'tempo_run', segment: 'tempo', hrZone: 4 }
};

/**
 * The session type of any other commitment, a class whose content is its own: a strength or
 * CrossFit-style class is a strength_class (m3-plan open question 'Commitments by discipline'),
 * an athletic one is S&C.
 */
export const COMMITMENT_TYPE: Readonly<
	Record<Exclude<Discipline, 'running' | 'distance_running'>, SessionType>
> = {
	powerlifting: 'strength_class',
	weightlifting: 'strength_class',
	strength: 'strength_class',
	hypertrophy: 'strength_class',
	muay_thai: 'muay_thai',
	athletic: 'strength_conditioning',
	custom: 'custom'
};
