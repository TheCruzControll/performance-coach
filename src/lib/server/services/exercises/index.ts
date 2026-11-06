/**
 * The exercise library (PRD §5) for the owner's screens and, from M5, the coach's tools: list and
 * look up exercises, create and retire the owner's own, and resolve free text to one exercise.
 * Callers import this module by path; services/index.ts does not re-export it.
 *
 * - The catalogue part of the library comes from code (CATALOGUE), as the generator reads it;
 *   its rows give the ids. Lookups by id or key keep retired rows readable, so a stored program
 *   always resolves. Lists and free text cover the live library only.
 * - A custom exercise's name and aliases may not clash with a catalogue name or alias, or with
 *   one of the owner's own, compared as the matcher compares them (case, accents, punctuation
 *   and plurals ignored), so free text keeps resolving to one exercise.
 * - Every change to the owner's custom exercises takes their lock, so a double-tapped Save gets
 *   a field error, never a unique violation.
 */
import { CATALOGUE, type CatalogueExercise } from '../../../domain/exercises/index';
import {
	matchExercise,
	normaliseExerciseName,
	type MatchableExercise
} from '../../../domain/exercises/match';
import { customExerciseSchema } from '../../../domain/training/schemas';
import {
	MEASURE_LABEL,
	MOVEMENT_PATTERN_LABEL,
	type Measure,
	type MovementPattern
} from '../../../domain/training/vocabulary';
import type { FieldErrors } from '../../../domain/validation';
import {
	createExercisesRepository,
	type ExerciseFilter,
	type ExerciseRow
} from '../../db/repositories/exercises';
import { measure } from '../../observability/timing';
import { isUuid } from '../ids';
import {
	parseWith,
	resolveDeps,
	TrainingInputError,
	TrainingNotFoundError,
	type TrainingDeps
} from '../training/shared';

export type { ExerciseFilter } from '../../db/repositories/exercises';

/**
 * A library exercise as the services return it: a catalogue row, with its key, or one of the
 * owner's own (key null). A retired row keeps every field and says when it left the library.
 */
export interface ExerciseDef extends Omit<CatalogueExercise, 'key'> {
	id: string;
	key: string | null;
	retiredAt: Date | null;
}

export function toExerciseDef(row: ExerciseRow): ExerciseDef {
	return {
		id: row.id,
		key: row.key,
		name: row.name,
		aliases: row.aliases,
		pattern: row.pattern,
		primaryMuscles: row.primaryMuscles,
		secondaryMuscles: row.secondaryMuscles,
		equipment: row.equipment,
		substitutionGroup: row.substitutionGroup,
		skillLevel: row.skillLevel,
		repMin: row.repMin,
		repMax: row.repMax,
		defaultSeconds: row.defaultSeconds,
		unilateral: row.unilateral,
		measure: row.measure,
		loadType: row.loadType,
		tags: row.tags,
		disciplines: row.disciplines,
		baselineLift: row.baselineLift,
		retiredAt: row.retiredAt
	};
}

// ---- the library's rules for custom exercises ---------------------------------------------

/** Who already uses a name: a catalogue entry or one of the owner's own. */
interface NameUse {
	name: string;
	custom: boolean;
}

/** Each name and alias of `library` as the matcher compares it, mapped to its exercise. */
function namesOf(library: readonly Pick<MatchableExercise, 'name' | 'aliases'>[], custom: boolean) {
	const names = new Map<string, NameUse>();
	for (const { name, aliases } of library) {
		for (const term of [name, ...aliases]) {
			const normal = normaliseExerciseName(term);
			if (normal && !names.has(normal)) names.set(normal, { name, custom });
		}
	}
	return names;
}

const CATALOGUE_NAMES = namesOf(CATALOGUE, false);

const takenBy = ({ name, custom }: NameUse) =>
	custom ? `You already have ${name}` : `Already in the library as ${name}`;

/**
 * What each substitution group's members share. A catalogue group keeps one pattern and one
 * measure, so a swap within it keeps the training intent and the prescription still reads; a
 * custom exercise joins a group only on both.
 */
const GROUPS = new Map<string, { pattern: MovementPattern; measures: Set<Measure> }>();
for (const { substitutionGroup, pattern, measure } of CATALOGUE) {
	if (!substitutionGroup) continue;
	const group = GROUPS.get(substitutionGroup) ?? { pattern, measures: new Set<Measure>() };
	group.measures.add(measure);
	GROUPS.set(substitutionGroup, group);
}

function groupProblem({
	substitutionGroup,
	pattern,
	measure
}: Pick<CatalogueExercise, 'substitutionGroup' | 'pattern' | 'measure'>): string | null {
	if (substitutionGroup === null) return null;
	const group = GROUPS.get(substitutionGroup);
	if (!group) return 'Not a substitution group';
	if (group.pattern !== pattern) {
		return `This group is for the ${MOVEMENT_PATTERN_LABEL[group.pattern]} pattern`;
	}
	if (!group.measures.has(measure)) {
		const measures = [...group.measures].map((m) => MEASURE_LABEL[m].toLowerCase());
		return `This group's exercises are measured in ${measures.join(' or ')}`;
	}
	return null;
}

/** What the schema cannot see: the group and names the library already uses. */
function libraryProblems(
	exercise: Pick<
		CatalogueExercise,
		'name' | 'aliases' | 'substitutionGroup' | 'pattern' | 'measure'
	>,
	own: readonly ExerciseRow[]
): FieldErrors {
	const errors: FieldErrors = {};
	const group = groupProblem(exercise);
	if (group) errors.substitutionGroup = group;
	const ownNames = namesOf(own, true);
	const clash = (term: string) => {
		const normal = normaliseExerciseName(term);
		return CATALOGUE_NAMES.get(normal) ?? ownNames.get(normal);
	};
	const name = clash(exercise.name);
	if (name) errors.name = takenBy(name);
	exercise.aliases.forEach((alias, index) => {
		const use = clash(alias);
		if (use) errors[`aliases.${index}`] = takenBy(use);
	});
	return errors;
}

// ---- reads --------------------------------------------------------------------------------

/** The live library: every catalogue exercise and the owner's own, by name. */
export async function listExercises(
	ownerId: string,
	filter: ExerciseFilter = {},
	deps: TrainingDeps = {}
): Promise<ExerciseDef[]> {
	const { db } = resolveDeps(deps);
	const rows = await measure('db', () => createExercisesRepository(db).listLive(ownerId, filter));
	return rows.map(toExerciseDef);
}

/** Exercises by id, retired ones included; an id that is malformed or not found is left out. */
export async function getExercisesByIds(
	ownerId: string,
	ids: readonly string[],
	deps: TrainingDeps = {}
): Promise<ReadonlyMap<string, ExerciseDef>> {
	const { db } = resolveDeps(deps);
	const wellFormed = [...new Set(ids)].filter(isUuid);
	const rows = await measure('db', () => createExercisesRepository(db).byIds(ownerId, wellFormed));
	return new Map(rows.map((row) => [row.id, toExerciseDef(row)]));
}

/**
 * Catalogue exercises by key, retired rows included: a key another preview's seed retired still
 * resolves. A key that was never seeded is left out.
 */
export async function resolveKeys(
	keys: readonly string[],
	deps: TrainingDeps = {}
): Promise<ReadonlyMap<string, ExerciseDef>> {
	const { db } = resolveDeps(deps);
	const rows = await measure('db', () =>
		createExercisesRepository(db).byKeys([...new Set(keys)], { includeRetired: true })
	);
	return new Map(rows.map((row) => [row.key!, toExerciseDef(row)]));
}

/** The owner's live custom exercises, by name: the generator's input and digest take them. */
export async function listCustomExercises(
	ownerId: string,
	deps: TrainingDeps = {}
): Promise<ExerciseDef[]> {
	const { db } = resolveDeps(deps);
	const rows = await measure('db', () => createExercisesRepository(db).listCustom(ownerId));
	return rows.map(toExerciseDef);
}

// ---- the owner's own exercises ------------------------------------------------------------

/**
 * Add an exercise to the owner's library. Creating one with the name of an exercise the owner
 * retired brings that one back with the new definition, keeping its id, as the catalogue seed
 * restores a key that returns.
 */
export async function createCustomExercise(
	ownerId: string,
	input: unknown,
	deps: TrainingDeps = {}
): Promise<ExerciseDef> {
	const exercise = parseWith(customExerciseSchema, input);
	const { db, now } = resolveDeps(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createExercisesRepository(tx);
			await repo.lockCustom(ownerId);
			const errors = libraryProblems(exercise, await repo.listCustom(ownerId));
			const sameName = await repo.findCustomByName(ownerId, exercise.name);
			if (sameName && !sameName.retiredAt) {
				errors.name ??= takenBy({ name: sameName.name, custom: true });
			}
			if (Object.keys(errors).length > 0) throw new TrainingInputError(errors);
			const at = now();
			const row = sameName
				? await repo.restoreCustom(ownerId, sameName.id, exercise, at)
				: await repo.insertCustom(ownerId, exercise, at);
			return toExerciseDef(row);
		})
	);
}

/**
 * Take one of the owner's exercises out of the library. Programs that use it keep it, readable
 * by id. Retiring it again returns it as it is.
 */
export async function retireCustomExercise(
	ownerId: string,
	id: string,
	deps: TrainingDeps = {}
): Promise<ExerciseDef> {
	if (!isUuid(id)) throw new TrainingNotFoundError('exercise');
	const { db, now } = resolveDeps(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createExercisesRepository(tx);
			await repo.lockCustom(ownerId);
			const retired = await repo.retireCustom(ownerId, id, now());
			if (retired) return toExerciseDef(retired);
			const [row] = await repo.byIds(ownerId, [id]);
			// Catalogue rows are no one's to retire.
			if (!row || row.ownerId !== ownerId) throw new TrainingNotFoundError('exercise');
			return toExerciseDef(row);
		})
	);
}

// ---- free text ----------------------------------------------------------------------------

/** The matcher's key for one of the owner's exercises; catalogue keys never contain ':'. */
const customKey = (id: string) => `custom:${id}`;

/**
 * The one live exercise each text names (domain/exercises/match.ts), or null: unknown text, part
 * of a name, or a name two exercises share. One call for a whole list, as a Profile save needs.
 */
export async function resolveExerciseNames(
	ownerId: string,
	texts: readonly string[],
	deps: TrainingDeps = {}
): Promise<(ExerciseDef | null)[]> {
	const { db } = resolveDeps(deps);
	return measure('db', async () => {
		const repo = createExercisesRepository(db);
		const own = new Map((await repo.listCustom(ownerId)).map((row) => [customKey(row.id), row]));
		const library: MatchableExercise[] = [
			...CATALOGUE,
			...[...own].map(([key, { name, aliases }]) => ({ key, name, aliases }))
		];
		const keys = texts.map((text) => matchExercise(text, library));
		const wanted = new Set(keys.filter((key): key is string => key !== null && !own.has(key)));
		const rows = await repo.byKeys([...wanted], { includeRetired: true });
		const catalogue = new Map(rows.map((row) => [row.key!, row]));
		return keys.map((key) => {
			const row = key === null ? undefined : (own.get(key) ?? catalogue.get(key));
			return row ? toExerciseDef(row) : null;
		});
	});
}

export async function resolveExerciseName(
	ownerId: string,
	text: string,
	deps: TrainingDeps = {}
): Promise<ExerciseDef | null> {
	const [exercise] = await resolveExerciseNames(ownerId, [text], deps);
	return exercise ?? null;
}
