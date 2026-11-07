/**
 * Programming use-cases (PRD §5): preview the program the generator makes from the owner's
 * profile, then build it as version 1. Today's Build card (m3/42) and the coach's tools (M5) call
 * the same functions. Callers import this module by path; services/index.ts does not re-export it.
 */
export {
	DECISION_GROUP,
	ONBOARDING_FIRST,
	previewProgram,
	type DecisionGroup,
	type PreviewDay,
	type PreviewSummary,
	type PreviewWeek,
	type ProgrammingDeps,
	type ProgramPreview
} from './preview';
export {
	buildProgram,
	ProgrammingConflictError,
	type BuildRequest,
	type ProgrammingConflictReason
} from './build';
export {
	DEFAULT_PROGRAM_START,
	PROGRAM_STARTS,
	START_OPTIONS,
	startDates,
	type PreviewRequest,
	type ProgramStart,
	type StartDates
} from './start';
