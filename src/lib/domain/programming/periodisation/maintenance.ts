/**
 * The maintenance block as a week plan (m7-plan maintenance-doses; PRD §5): every goal at its
 * dose, for 4–8 weeks, every week of kind maintenance and none a deload, because the block's
 * volume is already low. Used when every goal is paused (M3's all-goals-paused block), between
 * events, after the last one, for an off-season and on request. Each week is a skeleton, its kind,
 * its phase and its targets; the generator fills in dates and sessions. Pure and deterministic.
 */
import type { ExperienceLevel } from '../../profile/catalog.ts';
import type { WeekTargets } from '../../training/types.ts';
import type { GoalDose } from '../priority/doses.ts';
import { MAINTENANCE_BLOCK } from '../rules/maintenance.ts';
import { BLOCK_WEEK_KINDS } from './kinds.ts';

/** One week of a maintenance block, before it has dates and sessions. */
export interface MaintenanceWeek {
	kind: typeof BLOCK_WEEK_KINDS.maintenance.maintenance;
	phase: 'maintenance';
	targets: WeekTargets & { maintenance: NonNullable<WeekTargets['maintenance']> };
}

export interface MaintenanceBlock {
	phase: 'maintenance';
	/** The dosed goals' uuids, in the doses' order, once each. */
	goalRefs: string[];
	weeks: MaintenanceWeek[];
}

/**
 * A maintenance block of `weeks` weeks, kept within MAINTENANCE_BLOCK's 4–8, holding every goal in
 * `doses` (priority/doses.ts maintenanceDoses) at its dose. Strength and muscle building carry the
 * doses' band, which is doseBand's. `level` is taken as every block type takes it; a maintenance
 * dose does not change with experience, and the block schedules no deload whatever the level.
 */
export function maintenanceWeeks(
	doses: readonly GoalDose[],
	{ weeks }: { weeks: number; level: ExperienceLevel }
): MaintenanceBlock {
	if (!Number.isFinite(weeks)) throw new RangeError('weeks must be a number of weeks');
	const { min, max } = MAINTENANCE_BLOCK.weeks;
	const count = Math.min(max, Math.max(min, Math.round(weeks)));
	const lifting = doses.find((d) => 'hardSets' in d.dose)?.dose;
	const setsPerGroup =
		lifting && 'hardSets' in lifting
			? { min: lifting.hardSets[0], max: lifting.hardSets[1], step: 0 }
			: undefined;
	const targets = {
		rpeCap: MAINTENANCE_BLOCK.rpeCap,
		volumeFactor: 1,
		loadStep: 0,
		runVolumeFactor: MAINTENANCE_BLOCK.runVolumeFactor,
		maintenance: [...new Set(doses.map((d) => d.stream))],
		...(setsPerGroup && { setsPerGroup })
	};
	return {
		phase: 'maintenance',
		goalRefs: [...new Set(doses.map((d) => d.goal.id))],
		weeks: Array.from({ length: count }, () => ({
			kind: BLOCK_WEEK_KINDS.maintenance.maintenance,
			phase: 'maintenance',
			targets: structuredClone(targets)
		}))
	};
}
