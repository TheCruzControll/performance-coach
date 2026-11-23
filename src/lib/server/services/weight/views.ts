/**
 * What the weight writes answer: the rows the services store, trimmed to the fields the screens and
 * the coach's Undo endpoint use. The owner's run_id and replaced stay on the server (Undo reads them
 * there), and the goal and milestone columns the screens do not show are left out.
 */
import type { WeightEntryRow, WeightGoalRow, WeightMilestoneRow } from '../../db';

/** A weigh-in: the day's entry, without run_id and replaced. */
export const weighInView = ({ id, measuredOn, value, unit, source }: WeightEntryRow) => ({
	id,
	measuredOn,
	value,
	unit,
	source
});

/** A goal as the goal sheet takes it back: its id and the target it was set with. */
export const goalView = ({
	id,
	unit,
	startOn,
	startWeight,
	targetOn,
	targetWeight
}: WeightGoalRow) => ({
	id,
	unit,
	startOn,
	startWeight,
	targetOn,
	targetWeight
});

/** A milestone as the editor takes it back: its day (the column is onDate) and how it was made. */
export const milestoneView = ({ id, onDate, weight, source }: WeightMilestoneRow) => ({
	id,
	day: onDate,
	weight,
	source
});
