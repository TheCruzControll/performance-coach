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
 * - An index only a migration could add may be declared pending (m6-plan 'analytics-plans'), and
 *   only for PENDING_INDEX_SLOT: until it exists, its table's scans are recorded, not gated; once
 *   it exists, it is gated like any declared index.
 * - A case may opt one table in as a whole read ({ wholeRead: table }), for a query that reads most
 *   of it ('all' reads a window of every run's segments). Then one Seq Scan of that table, run
 *   once, returning WHOLE_READ_SHARE of its rows or more is the plan Postgres rightly picks: that
 *   node and the table's declared index are recorded, not gated. Any other Seq Scan of the table,
 *   one repeated in a loop included, is gated as before; no case opts in, no waiver.
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

/**
 * Owner decision (this slice's default, not the m6-plan's): the share of an opted-in large
 * relation's rows from which one scan reads it whole.
 */
export const WHOLE_READ_SHARE = 0.5;

/** Decision (m6-plan): the one migration slot a pending index may wait for. */
export const PENDING_INDEX_SLOT = 'analytics-explain';

/** An index a builder needs that no migration has added yet, and the table it will index. */
export interface PendingIndex {
	index: string;
	table: string;
	pendingIndex: typeof PENDING_INDEX_SLOT;
}

/** A table the case expects to read whole (see WHOLE_READ_SHARE). */
export interface WholeRead {
	wholeRead: string;
}

/** What a builder declares: an index's name, a pending one, or a table it may read whole. */
export type ExpectedIndex = string | PendingIndex | WholeRead;

const isPending = (entry: ExpectedIndex): entry is PendingIndex =>
	typeof entry !== 'string' && 'pendingIndex' in entry;

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

/** The pending indexes no migration has added yet: their tables are recorded, not gated. */
export function pendingOf(expected: readonly ExpectedIndex[], catalog: Catalog): PendingIndex[] {
	return expected.filter(
		(entry): entry is PendingIndex =>
			isPending(entry) &&
			entry.pendingIndex === PENDING_INDEX_SLOT &&
			!catalog.indexes.has(entry.index)
	);
}

export interface WholeReadScan {
	node: PlanNode;
	relation: string;
	share: number;
}

/** Each Seq Scan node reading an opted-in large table whole (see WHOLE_READ_SHARE). */
export function wholeReadsOf(
	plan: PlanNode,
	expected: readonly ExpectedIndex[],
	catalog: Catalog
): WholeReadScan[] {
	const tables = new Set(
		expected.flatMap((entry) =>
			typeof entry !== 'string' && 'wholeRead' in entry ? [entry.wholeRead] : []
		)
	);
	return [...walk(plan)].flatMap((node): WholeReadScan[] => {
		const relation = node['Relation Name'];
		const size = relation && tables.has(relation) ? catalog.relations.get(relation) : undefined;
		if (node['Node Type'] !== 'Seq Scan' || !size || sizeClass(size) === 'small') return [];
		const share = Number(node['Actual Rows']) / size.tuples;
		return node['Actual Loops'] === 1 && share >= WHOLE_READ_SHARE
			? [{ node, relation: relation!, share }]
			: [];
	});
}

/** What is wrong with the plan, in words; empty when it passes. */
export function checkPlan(
	plan: PlanNode,
	expected: readonly ExpectedIndex[],
	catalog: Catalog
): string[] {
	const scans = scansOf(plan, catalog);
	const pending = pendingOf(expected, catalog);
	const wholeReads = wholeReadsOf(plan, expected, catalog);
	const wholeNodes = new Set(wholeReads.map((read) => read.node));
	const waived = new Set(pending.map((entry) => entry.table));
	const problems = expected.flatMap((entry) =>
		isPending(entry) && entry.pendingIndex !== PENDING_INDEX_SLOT
			? [`${entry.index} may wait only for '${PENDING_INDEX_SLOT}', not '${entry.pendingIndex}'`]
			: []
	);
	for (const node of walk(plan)) {
		const relation = node['Relation Name'];
		const size = relation ? catalog.relations.get(relation) : undefined;
		if (node['Node Type'] !== 'Seq Scan' || !size || sizeClass(size) === 'small') continue;
		if (waived.has(relation!) || wholeNodes.has(node)) continue;
		problems.push(`Seq Scan on ${relation}, ${describeSize(relation!, catalog)}`);
	}
	for (const read of wholeReads) waived.add(read.relation);
	const declared = expected.flatMap((entry) =>
		typeof entry === 'string'
			? [entry]
			: isPending(entry) && !pending.includes(entry)
				? [entry.index]
				: []
	);
	for (const index of declared) {
		const table = catalog.indexes.get(index);
		if (!table) {
			problems.push(`${index} is not an index of this database`);
			continue;
		}
		const size = catalog.relations.get(table);
		if (!size || sizeClass(size) === 'small' || waived.has(table)) continue;
		const used = scans.some((s) => s.index === index && INDEX_SCANS.has(s.node));
		if (!used) problems.push(`${index} is not used on ${table}, ${describeSize(table, catalog)}`);
	}
	return problems;
}
