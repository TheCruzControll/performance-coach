/**
 * Seed the exercise library's catalogue rows from CATALOGUE. runMigrations calls this after every
 * migrate run, under the migration lock, so every database (dev, test, e2e, preview, production)
 * holds the catalogue the deployed code was built with.
 *
 * One statement, so a run is atomic: a jsonb_to_recordset upsert keyed by `key` that
 * - inserts new keys,
 * - updates a row only when its content differs (a rerun changes nothing, updated_at included),
 * - restores (clears retired_at on) a retired key that is back in the catalogue,
 * - retires every live key the catalogue no longer has, never deleting it, so ids stay stable
 *   and stored programs keep resolving.
 * Custom rows (no key) are never touched.
 *
 * Raw parameterised SQL with a runtime import of the domain catalogue only, through explicit .ts
 * specifiers: plain Node runs this from scripts/db-migrate.ts (scripts/catalogue-node.test.ts).
 */
import type { ClientBase } from 'pg';
import { CATALOGUE } from '../../../domain/exercises/index.ts';
import type { CatalogueExercise } from '../../../domain/exercises/index.ts';

/** What one run did. Each catalogue row counts once: a restored row is not also updated. */
export interface CatalogueSeed {
	inserted: number;
	updated: number;
	retired: number;
	restored: number;
}

/** The content columns the catalogue sets, with the types jsonb_to_recordset reads them as. */
const CONTENT = {
	name: 'text',
	aliases: 'text[]',
	pattern: 'text',
	primary_muscles: 'text[]',
	secondary_muscles: 'text[]',
	equipment: 'text[]',
	disciplines: 'text[]',
	tags: 'text[]',
	unilateral: 'boolean',
	skill_level: 'text',
	measure: 'text',
	load_type: 'text',
	rep_min: 'integer',
	rep_max: 'integer',
	default_seconds: 'integer',
	substitution_group: 'text',
	baseline_lift: 'text'
} as const;

type Column = keyof typeof CONTENT;
const COLUMNS = Object.keys(CONTENT) as Column[];
const columnList = (prefix = '') => COLUMNS.map((column) => prefix + column).join(', ');

/** One catalogue entry as the JSON record the statement reads. */
function toRecord(exercise: CatalogueExercise): Record<'key' | Column, unknown> {
	return {
		key: exercise.key,
		name: exercise.name,
		aliases: exercise.aliases,
		pattern: exercise.pattern,
		primary_muscles: exercise.primaryMuscles,
		secondary_muscles: exercise.secondaryMuscles,
		equipment: exercise.equipment,
		disciplines: exercise.disciplines,
		tags: exercise.tags,
		unilateral: exercise.unilateral,
		skill_level: exercise.skillLevel,
		measure: exercise.measure,
		load_type: exercise.loadType,
		rep_min: exercise.repMin,
		rep_max: exercise.repMax,
		default_seconds: exercise.defaultSeconds,
		substitution_group: exercise.substitutionGroup,
		baseline_lift: exercise.baselineLift
	};
}

// Every CTE reads the snapshot from before the statement, so `existing` is the prior state and
// the upsert and the retirement touch disjoint rows (keys in the catalogue, keys not in it).
const SEED_SQL = `
with incoming as (
	select * from jsonb_to_recordset($1::jsonb)
		as r(key text, ${COLUMNS.map((column) => `${column} ${CONTENT[column]}`).join(', ')})
),
existing as (
	select key, retired_at from exercises where key is not null
),
upserted as (
	insert into exercises as e (key, ${columnList()})
	select key, ${columnList()} from incoming
	on conflict (key) do update
		set ${COLUMNS.map((column) => `${column} = excluded.${column}`).join(', ')},
			retired_at = null, updated_at = now()
		where e.retired_at is not null
			or (${columnList('e.')}) is distinct from (${columnList('excluded.')})
	returning key
),
retired as (
	update exercises set retired_at = now(), updated_at = now()
	where key is not null and retired_at is null
		and not exists (select 1 from incoming i where i.key = exercises.key)
	returning key
)
select
	count(*) filter (where x.key is null)::int as inserted,
	count(*) filter (where x.key is not null and x.retired_at is null)::int as updated,
	count(*) filter (where x.retired_at is not null)::int as restored,
	(select count(*) from retired)::int as retired
from upserted u left join existing x on x.key = u.key
`;

/**
 * Bring the catalogue rows in line with `catalogue` (CATALOGUE unless a test passes a changed
 * one). Safe to run any number of times, on any database the migrations have reached.
 */
export async function seedExerciseCatalogue(
	client: Pick<ClientBase, 'query'>,
	catalogue: readonly CatalogueExercise[] = CATALOGUE
): Promise<CatalogueSeed> {
	const { rows } = await client.query<CatalogueSeed>(SEED_SQL, [
		JSON.stringify(catalogue.map(toRecord))
	]);
	return rows[0]!;
}
