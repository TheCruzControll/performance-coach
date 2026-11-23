/**
 * Weight-tracking use-cases: the owner's weigh-ins (entries.ts) and the reads behind the Weight
 * view, Today's card and the coach (read.ts). Goals arrive with goals.ts.
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
	windowFrom,
	type WeightFacts,
	type WeightGoalSummary,
	type WeightGoalView,
	type WeightReadDeps,
	type WeightToday,
	type WeightView
} from './read';
