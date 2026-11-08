/**
 * Program use-cases (PRD §5, ADR 0010) for the build, the program screens and, from M5, the
 * coach's tools. Callers import this module by path; services/index.ts does not re-export it.
 */
export {
	createProgramFromPlan,
	FIRST_VERSION_SUMMARY,
	getProgramVersion,
	ProgramExistsError,
	type CreatedProgram,
	type ProgramOrigin
} from './store';
export {
	getCurrentProgram,
	getPlannedSession,
	getTodayPlan,
	getTrainingWeek,
	UP_NEXT_LIMIT,
	type CurrentProgram,
	type PlannedSession,
	type ReadOptions,
	type SessionExercise,
	type SessionWeek,
	type TodayPlan,
	type TrainingWeek,
	type WeekAt
} from './read';
export {
	getVersionHistory,
	getVersionWeek,
	HISTORY_PAGE_SIZE,
	reviseProgram,
	type Copy,
	type CopyChanges,
	type RevisedVersion,
	type Revision,
	type RevisionDecision,
	type VersionHistory,
	type VersionHistoryEntry,
	type WeekCopies
} from './revise';
export {
	alternativesFor,
	alternativesForExercises,
	type ExerciseAlternative,
	type ExerciseAlternatives,
	type PlannedExerciseAt
} from './alternatives';
export {
	adjustPrescription,
	adjustRunSegment,
	adjustSessionDetails,
	checkMove,
	getMoveTargets,
	lockCurrentSlot,
	moveSession,
	NOTHING_CHANGED,
	skipSession,
	swapExercise,
	type EditAt,
	type MovedSession,
	type MoveTarget,
	type MoveWarning,
	type PlannedSlot,
	type SwapOptions
} from './edits';
export type {
	ProgramVersion,
	StoredBlock,
	StoredDecision,
	StoredExercise,
	StoredSession,
	StoredWeek
} from './mapping';
