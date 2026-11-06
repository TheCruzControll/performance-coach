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
export type {
	ProgramVersion,
	StoredBlock,
	StoredDecision,
	StoredExercise,
	StoredSession,
	StoredWeek
} from './mapping';
