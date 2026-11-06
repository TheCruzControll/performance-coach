/**
 * The db:explain gate (m3-plan 'history queries are defined once'): a rule by relation size, not
 * by table name, so it never asks for an index Postgres would rightly ignore.
 * - After ANALYZE, a relation is large from LARGE_TUPLES rows or LARGE_PAGES pages (pg_class's
 *   reltuples and relpages). Below both, a sequential scan is the right plan at one owner's
 *   scale, so small relations' plans are recorded, never gated.
 * - On a large relation a plan must not Seq Scan, wherever the scan sits (under joins, in an
 *   InitPlan or SubPlan), and each index the builder declares must be used: an Index Scan, Index
 *   Only Scan or Bitmap Index Scan on that name.
 * Scan types and index names are asserted; timings are recorded only, since a planner on CI and
 * one on Neon may cost the same plan differently.
 */

/** Decision (m3-plan): the size from which a relation's plans are gated. */
export const LARGE_TUPLES = 5_000;
export const LARGE_PAGES = 50;

export interface RelationSize {
	/** pg_class.reltuples: -1 until the relation is analysed. */
	tuples: number;
	pages: number;
}

export type SizeClass = 'large' | 'small';

/** One node of an EXPLAIN (FORMAT JSON) plan, with the fields the gate reads. */
export interface PlanNode {
	'Node Type': string;
	'Relation Name'?: string;
	'Index Name'?: string;
	Plans?: PlanNode[];
	[field: string]: unknown;
}

/** The database's relations by name, and each index's table. */
export interface Catalog {
	relations: ReadonlyMap<string, RelationSize>;
	indexes: ReadonlyMap<string, string>;
}

export interface Scan {
	node: string;
	relation: string;
	index: string | null;
	size: SizeClass;
}

const INDEX_SCANS = new Set(['Index Scan', 'Index Only Scan', 'Bitmap Index Scan']);

export const sizeClass = ({ tuples, pages }: RelationSize): SizeClass =>
	tuples >= LARGE_TUPLES || pages >= LARGE_PAGES ? 'large' : 'small';

function* walk(node: PlanNode): Generator<PlanNode> {
	yield node;
	for (const child of node.Plans ?? []) yield* walk(child);
}

const describeSize = (relation: string, catalog: Catalog) => {
	const size = catalog.relations.get(relation);
	return size ? `a large relation (${Math.round(size.tuples)} rows, ${size.pages} pages)` : '';
};

/**
 * Every scan of a relation in the plan, in plan order, with its index and its relation's size
 * class. A Bitmap Index Scan names only its index: its relation is the index's table.
 */
export function scansOf(plan: PlanNode, catalog: Catalog): Scan[] {
	return [...walk(plan)].flatMap((node): Scan[] => {
		const index = node['Index Name'] ?? null;
		const relation = node['Relation Name'] ?? (index ? catalog.indexes.get(index) : undefined);
		if (!relation) return [];
		const size = catalog.relations.get(relation);
		return [{ node: node['Node Type'], relation, index, size: size ? sizeClass(size) : 'small' }];
	});
}

/** What is wrong with the plan, in words; empty when it passes. */
export function checkPlan(plan: PlanNode, expected: readonly string[], catalog: Catalog): string[] {
	const scans = scansOf(plan, catalog);
	const problems = scans
		.filter((scan) => scan.node === 'Seq Scan' && scan.size === 'large')
		.map((scan) => `Seq Scan on ${scan.relation}, ${describeSize(scan.relation, catalog)}`);
	for (const index of expected) {
		const table = catalog.indexes.get(index);
		if (!table) {
			problems.push(`${index} is not an index of this database`);
			continue;
		}
		const size = catalog.relations.get(table);
		if (!size || sizeClass(size) === 'small') continue;
		const used = scans.some((s) => s.index === index && INDEX_SCANS.has(s.node));
		if (!used) problems.push(`${index} is not used on ${table}, ${describeSize(table, catalog)}`);
	}
	return problems;
}
