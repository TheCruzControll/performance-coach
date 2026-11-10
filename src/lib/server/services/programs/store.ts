/**
 * The program store (PRD §5, ADR 0010): a ProgramPlan becomes a program and its version 1, with
 * every block, week, session, prescription and decision; and any version reads back whole. The
 * build (m3/36), the e2e fixture route (m3/27) and the coach's tools (M5) all store through
 * createProgramFromPlan, so it validates its own input:
 * - the plan is parsed with programPlanSchema; a bad one is a TrainingInputError by dotted path
 * - every ExerciseRef must be in the owner's library when stored: a catalogue key (retired rows
 *   included, so a preview's re-seed cannot break a build) or one of the owner's own exercises
 * - decision refs (plan paths) are stored as the lineage ids of the nodes they name.
 * It writes in one transaction under the owner's program lock, with one multi-row insert per
 * table, so the number of statements never grows with the plan.
 */
import type { ExerciseRef, ProgramPlan } from '../../../domain/training/types';
import { programPlanSchema } from '../../../domain/training/schemas';
import type { Decider } from '../../../domain/training/vocabulary';
import type { FieldErrors } from '../../../domain/validation';
import { createProgramsRepository, type ActiveProgramRow } from '../../db/repositories/programs';
import { measure } from '../../observability/timing';
import { getExercisesByIds, resolveKeys } from '../exercises/index';
import { isUuid } from '../ids';
import {
	ConflictError,
	parseWith,
	resolveDeps,
	TrainingInputError,
	TrainingNotFoundError,
	type TrainingDeps
} from '../training/shared';
import { planRows, toProgramVersion, type ProgramVersion } from './mapping';

/** Who built the plan, and from what: version 1 keeps it, so a build can be reproduced. */
export interface ProgramOrigin {
	/** The version's author: the rules (a build), the coach (M5) or the owner. */
	source: Decider;
	/** GENERATOR_ID; null for a plan that no generator built (a test fixture). */
	generator?: string | null;
	/** The input fingerprint, which makes a repeated build return the stored program. */
	fingerprint?: string | null;
	digest?: string | null;
	snapshot?: Record<string, unknown> | null;
}

export interface CreatedProgram {
	programId: string;
	/** Version 1. */
	versionId: string;
	/** False when the build had already been stored: nothing was written. */
	created: boolean;
}

/** The owner already has an active program, which `programId` names: nothing was written. */
export class ProgramExistsError extends ConflictError<'program_exists'> {
	readonly programId: string;

	constructor(programId: string) {
		super('program_exists', 'the owner already has an active program');
		this.name = 'ProgramExistsError';
		this.programId = programId;
	}
}

/** What version 1 changed, as History shows it. */
export const FIRST_VERSION_SUMMARY = 'Your first program';

/**
 * Decision (m3-plan open question 'Rebuilding'): while a program is active, building another is
 * refused, and archiving and regenerating are left to M5 and M6. The one exception is a repeat of
 * the same build (a double tap, a retried request): version 1 has the same fingerprint and no
 * edit has revised it, so the stored program is returned as it is.
 */
function repeatsBuild(active: ActiveProgramRow, fingerprint: string | null): boolean {
	return (
		fingerprint !== null && active.firstFingerprint === fingerprint && active.currentNumber === 1
	);
}

/** Each ExerciseRef in the plan, under the path its field errors take. */
function exerciseRefs(plan: ProgramPlan): [path: string, ref: ExerciseRef][] {
	const refs: [string, ExerciseRef][] = [];
	plan.blocks.forEach((block, b) =>
		block.weeks.forEach((week, w) =>
			week.sessions.forEach((session, s) => {
				if (session.kind !== 'strength') return;
				session.exercises.forEach((e, x) => {
					const at = `blocks.${b}.weeks.${w}.sessions.${s}.exercises.${x}`;
					refs.push([`${at}.exercise`, e.exercise]);
					if (e.substitutedFrom) refs.push([`${at}.substitutedFrom`, e.substitutedFrom]);
				});
			})
		)
	);
	return refs;
}

/** The library row of every ExerciseRef in the plan, or a TrainingInputError at each unknown one. */
export async function resolveExercises(
	ownerId: string,
	plan: ProgramPlan,
	deps: TrainingDeps
): Promise<(ref: ExerciseRef) => string> {
	const refs = exerciseRefs(plan);
	const keys = refs.flatMap(([, ref]) => ('key' in ref ? [ref.key] : []));
	const ids = refs.flatMap(([, ref]) => ('customId' in ref ? [ref.customId] : []));
	const catalogue = await resolveKeys(keys, deps);
	const library = await getExercisesByIds(ownerId, ids, deps);
	const idOf = (ref: ExerciseRef) => {
		if ('key' in ref) return catalogue.get(ref.key)?.id;
		const own = library.get(ref.customId);
		// A catalogue row by id is not one of the owner's own: catalogue rows go by key.
		return own && own.key === null ? own.id : undefined;
	};
	const errors: FieldErrors = {};
	for (const [path, ref] of refs) {
		if (!idOf(ref)) errors[path] = 'Not in your exercise library';
	}
	if (Object.keys(errors).length > 0) throw new TrainingInputError(errors);
	return (ref) => idOf(ref)!;
}

/**
 * Store `input`, a ProgramPlan, as the owner's new active program and its version 1. Refused
 * with a ProgramExistsError while another program is active, unless it repeats that build.
 */
export async function createProgramFromPlan(
	ownerId: string,
	input: unknown,
	origin: ProgramOrigin,
	deps: Omit<TrainingDeps, 'source'> = {}
): Promise<CreatedProgram> {
	const plan = parseWith(programPlanSchema, input);
	const { db, now } = resolveDeps(deps);
	const fingerprint = origin.fingerprint ?? null;
	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createProgramsRepository(tx);
			await repo.lockPrograms(ownerId);
			const active = await repo.activeProgram(ownerId);
			if (active) {
				if (!repeatsBuild(active, fingerprint)) throw new ProgramExistsError(active.id);
				return { programId: active.id, versionId: active.currentVersionId!, created: false };
			}
			const exerciseId = await resolveExercises(ownerId, plan, { db: tx });
			const { tree, decisions } = planRows(plan, {
				ownerId,
				at: now(),
				version: {
					createdBy: origin.source,
					summary: FIRST_VERSION_SUMMARY,
					generator: origin.generator ?? null,
					inputFingerprint: fingerprint,
					catalogueDigest: origin.digest ?? null,
					inputSnapshot: origin.snapshot ?? null
				},
				exerciseId
			});
			await repo.insertProgramTree(tree);
			await repo.insertDecisions(decisions);
			return { programId: tree.program.id, versionId: tree.version.id, created: true };
		})
	);
}

/** Postgres's integer: a larger version number would be a 500, not 'not found'. */
export const MAX_VERSION = 2 ** 31 - 1;

/** Version `number` of one of the owner's programs, its whole tree and the decisions it made. */
export async function getProgramVersion(
	ownerId: string,
	programId: string,
	number: number,
	deps: TrainingDeps = {}
): Promise<ProgramVersion> {
	if (!isUuid(programId) || !Number.isInteger(number) || number < 1 || number > MAX_VERSION) {
		throw new TrainingNotFoundError('program version');
	}
	const { db } = resolveDeps(deps);
	return measure('db', async () => {
		const repo = createProgramsRepository(db);
		const found = await repo.findVersion(ownerId, programId, number);
		if (!found) throw new TrainingNotFoundError('program version');
		const tree = await repo.versionTree(found.version.id);
		return toProgramVersion(found, tree, await repo.decisionsOf(found.version.id));
	});
}
