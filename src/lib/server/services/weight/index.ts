/**
 * Weight-tracking use-cases: the owner's weigh-ins (entries.ts), the one weight goal and its
 * milestones (goals.ts), and the reads behind the Weight view, Today's card and the coach (read.ts).
 */
export {
	deleteWeight,
	editWeight,
	logWeight,
	undoCoachWeight,
	WeightUndoError,
	type WeightDeps
} from './entries';
export {
	FACTS_LOG_ROWS,
	FACTS_STATS_DAYS,
	getWeightFacts,
	getWeightToday,
	getWeightView,
	listThreadWeightLogs,
	windowFrom,
	type ThreadWeighIn,
	type WeightFacts,
	type WeightGoalSummary,
	type WeightGoalView,
	type WeightReadDeps,
	type WeightToday,
	type WeightView
} from './read';
export {
	clearWeightGoal,
	editMilestones,
	setNutritionPhase,
	setWeightGoal,
	syncWeightTarget,
	type WeightGoalResult,
	type WeightTarget
} from './goals';
export { goalView, milestoneView, weighInView } from './views';
