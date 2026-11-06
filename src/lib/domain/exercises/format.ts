/**
 * The exercise catalogue's source format: one exercise per line of a pipe table in a template
 * literal. Prettier never reflows those lines, so about 160 entries stay reviewable in two files.
 *
 * Every table starts with CATALOGUE_HEADER, word for word. The literal is reserved as the
 * catalogue's bundle signature, the string the budget check looks for to keep the library out of
 * browser bundles, so the header never changes: only the parser may.
 *
 * Cells are trimmed, so columns may be padded. Lists are comma-separated, `-` is empty or none.
 * - aliases, secondary, equipment, tags, disciplines: lists (`-` for none)
 * - primary: a list of at least one muscle
 * - equipment: M2 EQUIPMENT keys, every one required (`-` needs nothing: bodyweight)
 * - group: the substitution group's key, or `-`
 * - reps: `8` or `6-10` for a reps-measured entry, otherwise `-`
 * - seconds: the default seconds of a time-measured entry, otherwise `-`
 * - uni: `y` for a unilateral entry (one side at a time), otherwise `-`
 * - measure/load: a MEASURES key and a LOAD_TYPES key, as in `reps/external`
 * - lift: the M2 LIFTS key whose baseline the entry is, or `-`
 *
 * Runtime imports use explicit .ts specifiers: the migrate script's seed loads this under plain
 * Node (scripts/catalogue-node.test.ts).
 */
import { DISCIPLINES, EQUIPMENT, LIFTS } from '../profile/catalog.ts';
import type { Discipline, Equipment, Lift } from '../profile/catalog.ts';
import * as vocabulary from '../training/vocabulary.ts';

export const CATALOGUE_HEADER =
	'key | name | aliases | pattern | primary | secondary | equipment | group | skill | reps | seconds | uni | measure/load | tags | disciplines | lift';

/** One catalogue entry. Field names follow the `exercises` table's columns. */
export interface CatalogueExercise {
	key: string;
	name: string;
	aliases: readonly string[];
	pattern: vocabulary.MovementPattern;
	primaryMuscles: readonly vocabulary.Muscle[];
	secondaryMuscles: readonly vocabulary.Muscle[];
	equipment: readonly Equipment[];
	substitutionGroup: string | null;
	skillLevel: vocabulary.SkillLevel;
	repMin: number | null;
	repMax: number | null;
	defaultSeconds: number | null;
	unilateral: boolean;
	measure: vocabulary.Measure;
	loadType: vocabulary.LoadType;
	tags: readonly vocabulary.ExerciseTag[];
	disciplines: readonly Discipline[];
	baselineLift: Exclude<Lift, 'custom'> | null;
}

/** A catalogue part's substitution groups: key → the training intent every member preserves. */
export type SubstitutionGroups = Readonly<Record<string, string>>;

const COLUMNS = CATALOGUE_HEADER.split(' | ').length;
const SNAKE_CASE = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const CATALOGUE_DISCIPLINES = DISCIPLINES.filter((d) => d !== 'custom');
const CATALOGUE_LIFTS = LIFTS.filter((lift) => lift !== 'custom');

type Fail = (message: string) => never;
/** A row's cells; parseTable has checked there is one per column. */
type Cells = string[] & Record<0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10, string>;

function one<K extends string>(value: string, allowed: readonly K[], what: string, fail: Fail): K {
	if (!(allowed as readonly string[]).includes(value)) fail(`unknown ${what} '${value}'`);
	return value as K;
}

function list<K extends string>(value: string, allowed: readonly K[], what: string, fail: Fail) {
	if (value === '-') return [];
	const keys = value.split(',').map((key) => one(key.trim(), allowed, what, fail));
	if (new Set(keys).size !== keys.length) fail(`a ${what} is listed twice in '${value}'`);
	return keys;
}

/** A whole number ≥ 1 written in digits, or null for `-`. */
function count(value: string, what: string, fail: Fail): number | null {
	if (value === '-') return null;
	if (!/^[1-9]\d*$/.test(value)) fail(`${what} must be a whole number ≥ 1 or '-', not '${value}'`);
	return Number(value);
}

function parseRow(cells: string[], fail: Fail): CatalogueExercise {
	const [key, name, aliases, pattern, primary, secondary, equipment, group, skill, reps, seconds] =
		cells as Cells;
	const [uni, measureLoad, tags, disciplines, lift] = cells.slice(11) as Cells;

	if (!SNAKE_CASE.test(key)) fail(`key '${key}' must be snake_case`);
	if (!name || name === '-') fail('name is required');
	if (group !== '-' && !SNAKE_CASE.test(group)) fail(`group '${group}' must be snake_case or '-'`);

	const [measureKey = '', loadKey = '', ...extra] = measureLoad.split('/');
	if (extra.length) fail(`measure/load must be '<measure>/<load type>', not '${measureLoad}'`);
	const measure = one(measureKey.trim(), vocabulary.MEASURES, 'measure', fail);
	const loadType = one(loadKey.trim(), vocabulary.LOAD_TYPES, 'load type', fail);

	const primaryMuscles = list(primary, vocabulary.MUSCLES, 'muscle', fail);
	const secondaryMuscles = list(secondary, vocabulary.MUSCLES, 'muscle', fail);
	if (!primaryMuscles.length) fail('primary needs at least one muscle');
	const both = secondaryMuscles.find((muscle) => primaryMuscles.includes(muscle));
	if (both) fail(`'${both}' is both a primary and a secondary muscle`);

	const range = /^(\d+)(?:-(\d+))?$/.exec(reps);
	if (reps !== '-' && !range) fail(`reps must be '8', '6-10' or '-', not '${reps}'`);
	const repMin = range ? count(range[1]!, 'reps', fail) : null;
	const repMax = range ? count(range[2] ?? range[1]!, 'reps', fail) : null;
	if (repMin !== null && repMax !== null && repMin > repMax) fail(`reps ${reps} run high to low`);
	if (measure === 'reps' && repMin === null) fail('a reps-measured entry needs reps');
	if (measure !== 'reps' && repMin !== null) fail(`reps are for the reps measure, not ${measure}`);

	const defaultSeconds = count(seconds, 'seconds', fail);
	if (measure === 'time' && defaultSeconds === null) fail('a time-measured entry needs seconds');
	if (measure !== 'time' && defaultSeconds !== null) {
		fail(`seconds are for the time measure, not ${measure}`);
	}
	if (uni !== 'y' && uni !== '-') fail(`uni must be 'y' or '-', not '${uni}'`);

	return {
		key,
		name,
		aliases: aliases === '-' ? [] : aliases.split(',').map((alias) => alias.trim()),
		pattern: one(pattern, vocabulary.MOVEMENT_PATTERNS, 'pattern', fail),
		primaryMuscles,
		secondaryMuscles,
		equipment: list(equipment, EQUIPMENT, 'equipment', fail),
		substitutionGroup: group === '-' ? null : group,
		skillLevel: one(skill, vocabulary.SKILL_LEVELS, 'skill level', fail),
		repMin,
		repMax,
		defaultSeconds,
		unilateral: uni === 'y',
		measure,
		loadType,
		tags: list(tags, vocabulary.EXERCISE_TAGS, 'tag', fail),
		disciplines: list(disciplines, CATALOGUE_DISCIPLINES, 'discipline', fail),
		baselineLift: lift === '-' ? null : one(lift, CATALOGUE_LIFTS, 'lift', fail)
	};
}

/**
 * Parse one catalogue table. `file` names its source in errors, which also give the line (counted
 * from the template literal's first line) and the entry's key. Any unknown key, inconsistent
 * field, duplicate key or missing header throws, so a bad table fails the build, the tests and
 * the seed, never a request.
 */
export function parseTable(file: string, text: string): CatalogueExercise[] {
	const rows: CatalogueExercise[] = [];
	const keys = new Set<string>();
	let header = false;
	text.split('\n').forEach((raw, index) => {
		const line = raw.trim();
		if (!line) return;
		const cells = line.split('|').map((cell) => cell.trim());
		const where = `${file}:${index + 1}${header && cells[0] ? ` (${cells[0]})` : ''}`;
		const fail: Fail = (message) => {
			throw new Error(`${where}: ${message}`);
		};
		if (!header) {
			if (line !== CATALOGUE_HEADER) fail(`the table must start with '${CATALOGUE_HEADER}'`);
			header = true;
			return;
		}
		if (cells.length !== COLUMNS) fail(`expected ${COLUMNS} columns, found ${cells.length}`);
		const row = parseRow(cells, fail);
		if (keys.has(row.key)) fail(`duplicate key '${row.key}'`);
		keys.add(row.key);
		rows.push(row);
	});
	if (!header) throw new Error(`${file}: the table has no '${CATALOGUE_HEADER}' header`);
	return rows;
}
