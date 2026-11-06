/**
 * The generator (PRD §5): the public entry point that services (services/programming, m3/36)
 * and the M5 coach's tools call, so the UI and the coach build, fingerprint and check programs
 * through the same functions.
 *
 * - buildProgrammingInput normalises an M2 profile; generateProgram turns it into a plan the
 *   program-plan contract accepts, or throws a GeneratedPlanError.
 * - catalogueDigest, fingerprint and GENERATOR_ID make a build reproducible and detect a changed
 *   profile or library between a preview and its build.
 * - checkWeek judges a week by the interference rules; alternativesFor lists an exercise's swaps.
 *
 * Pure and server-only, like the whole package: pages may only `import type` from it. Like the
 * other domain packages, it is not re-exported from src/lib/domain/index.ts.
 */
export { alternativesFor } from './alternatives.ts';
export type { Alternative, Alternatives } from './alternatives.ts';
export { GeneratedPlanError, generateProgram } from './generate.ts';
export { buildProgrammingInput } from './input.ts';
export type {
	Assumption,
	ExerciseKey,
	InputSources,
	LinkedPreference,
	OwnedExercise,
	ProgrammingInput
} from './input.ts';
export { checkWeek } from './interference.ts';
export type { CheckOptions, InterferenceSession, Severity, Violation } from './interference.ts';
export { catalogueDigest, fingerprint, GENERATOR_ID } from './random.ts';
export type { GenerateOptions } from './stage.ts';
