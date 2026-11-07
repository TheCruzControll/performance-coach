/**
 * The order a backup's tables are restored in (M9), decided as a pure function of the catalog
 * before any database is touched.
 *
 * Restore loads each table in one `INSERT … SELECT`, with SET CONSTRAINTS ALL DEFERRED, so only a
 * foreign key that is checked at the end of a statement constrains the order:
 *
 * - A self-reference never does. Postgres checks a NOT DEFERRABLE key after the statement, when
 *   every row of the table is already in, so a self-referencing table loads in one statement.
 * - A DEFERRABLE key never does: it is checked at COMMIT, after every table is in.
 * - Every other key puts the table it references before the table that holds it.
 *
 * Those keys are a graph; its strongly connected components (Tarjan) are its cycles. Inside a
 * component of two or more tables, a key whose columns are all nullable is made late: restore
 * inserts its columns as NULL and fills them in, joined on the primary key, once every table is in
 * (programs.current_version_id, which points at a version of the same program). The key with the
 * fewest columns goes first, then by table and key name, until no cycle is left. A cycle with no
 * such key is refused, naming its tables and keys, and so is a key into a table the backup leaves
 * out. Tables then come out in topological order, ties broken by name, so the same catalog gives
 * the same plan whatever order it was read in.
 *
 * No imports: scripts run this module under plain Node.
 */

export interface CatalogColumn {
	name: string;
	/** As format_type gives it, such as `timestamp with time zone`. */
	type: string;
	nullable: boolean;
	/** A GENERATED ALWAYS AS (…) STORED column, which restore never writes. */
	generated: boolean;
	identity: 'always' | 'by default' | null;
}

export interface CatalogForeignKey {
	/** The constraint's name. */
	name: string;
	/** The holding table's columns, in key order. */
	columns: string[];
	/** The referenced table. */
	references: string;
	referencedColumns: string[];
	deferrable: boolean;
}

export interface CatalogSequence {
	name: string;
	/** The table and column that own it, if any. */
	table: string | null;
	column: string | null;
}

export interface CatalogTable {
	name: string;
	/** In attnum order. */
	columns: CatalogColumn[];
	/** The primary key's columns, in key order; empty when the table has none. */
	primaryKey: string[];
	foreignKeys: CatalogForeignKey[];
}

/** The public schema's tables, as server/db/backup/catalog.ts reads them from pg_catalog. */
export interface Catalog {
	tables: CatalogTable[];
	sequences: CatalogSequence[];
}

/** A key whose columns restore inserts as NULL and fills in once every table is in. */
export interface LateColumns {
	table: string;
	columns: string[];
	/** The constraint's name. */
	fk: string;
}

export interface RestorePlan {
	/** Every table the backup holds, in load order. */
	order: string[];
	/** By table, then key name. */
	late: LateColumns[];
}

export type RestorePlanErrorCode = 'unbreakable_cycle' | 'references_excluded_table';

/** A catalog no restore order can load. It names tables and keys, never a row's value. */
export class RestorePlanError extends Error {
	readonly code: RestorePlanErrorCode;
	readonly tables: string[];
	/** As `table.constraint`. */
	readonly foreignKeys: string[];

	constructor(code: RestorePlanErrorCode, tables: string[], foreignKeys: string[]) {
		const named = `${tables.join(', ')} (${foreignKeys.join(', ')})`;
		super(
			code === 'unbreakable_cycle'
				? `No restore order: ${named} form a cycle with no key whose columns are all nullable`
				: `No restore order: ${named} reference a table the backup leaves out`
		);
		this.name = 'RestorePlanError';
		this.code = code;
		this.tables = tables;
		this.foreignKeys = foreignKeys;
	}
}

/** Code-unit order: the same on every machine and in every locale, unlike localeCompare. */
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

interface Edge {
	/** The referenced table, which loads first. */
	from: string;
	/** The holding table. */
	to: string;
	key: CatalogForeignKey;
	nullable: boolean;
}

const edgeOrder = (a: Edge, b: Edge) =>
	a.key.columns.length - b.key.columns.length ||
	byText(a.to, b.to) ||
	byText(a.key.name, b.key.name);

/** Tarjan's strongly connected components of `nodes` over `edges`, each in name order. */
function components(nodes: readonly string[], edges: readonly Edge[]): string[][] {
	const next = new Map<string, string[]>(nodes.map((n) => [n, []]));
	for (const e of edges) next.get(e.from)!.push(e.to);
	const index = new Map<string, number>();
	const low = new Map<string, number>();
	const stack: string[] = [];
	const onStack = new Set<string>();
	const found: string[][] = [];
	const visit = (node: string) => {
		index.set(node, index.size);
		low.set(node, index.get(node)!);
		stack.push(node);
		onStack.add(node);
		for (const to of next.get(node)!) {
			if (!index.has(to)) {
				visit(to);
				low.set(node, Math.min(low.get(node)!, low.get(to)!));
			} else if (onStack.has(to)) {
				low.set(node, Math.min(low.get(node)!, index.get(to)!));
			}
		}
		if (low.get(node) === index.get(node)) {
			const component: string[] = [];
			let member: string;
			do {
				member = stack.pop()!;
				onStack.delete(member);
				component.push(member);
			} while (member !== node);
			found.push(component.sort(byText));
		}
	};
	for (const node of nodes) if (!index.has(node)) visit(node);
	return found;
}

/**
 * Makes late, inside one component, the keys that break its cycles, or refuses it. Each pass
 * makes late the first breakable key of every cycle still left, then looks again.
 */
function breakCycles(members: readonly string[], edges: readonly Edge[], late: Set<Edge>) {
	const inside = new Set(members);
	const own = edges.filter((e) => inside.has(e.from) && inside.has(e.to));
	for (;;) {
		const left = own.filter((e) => !late.has(e));
		const cycles = components(members, left).filter((c) => c.length > 1);
		if (!cycles.length) return;
		for (const cycle of cycles) {
			const within = new Set(cycle);
			const keys = left.filter((e) => within.has(e.from) && within.has(e.to)).sort(edgeOrder);
			const breakable = keys.find((e) => e.nullable);
			if (!breakable) {
				throw new RestorePlanError(
					'unbreakable_cycle',
					cycle,
					keys.map((e) => `${e.to}.${e.key.name}`).sort(byText)
				);
			}
			late.add(breakable);
		}
	}
}

/**
 * The restore plan for `catalog`'s tables, less `excluded` (a name the catalog does not hold is
 * ignored). A malformed catalog (a repeated table, a key into a table it does not hold or on a
 * column its table lacks) is a caller bug and throws a RangeError.
 */
export function planRestore(catalog: Catalog, excluded: Iterable<string>): RestorePlan {
	const leftOut = new Set(excluded);
	const all = new Map<string, CatalogTable>();
	for (const table of catalog.tables) {
		if (all.has(table.name)) throw new RangeError(`The catalog repeats table ${table.name}`);
		all.set(table.name, table);
	}
	const tables = [...all.values()]
		.filter((t) => !leftOut.has(t.name))
		.sort((a, b) => byText(a.name, b.name));
	const names = tables.map((t) => t.name);

	const edges: Edge[] = [];
	const intoExcluded: string[] = [];
	const excludedTargets = new Set<string>();
	for (const table of tables) {
		const columns = new Map(table.columns.map((c) => [c.name, c]));
		for (const key of table.foreignKeys) {
			if (!all.has(key.references)) {
				throw new RangeError(
					`${table.name}.${key.name} references ${key.references}, not in the catalog`
				);
			}
			const held = key.columns.map((name) => {
				const column = columns.get(name);
				if (!column)
					throw new RangeError(`${table.name}.${key.name} names a missing column ${name}`);
				return column;
			});
			if (leftOut.has(key.references)) {
				intoExcluded.push(`${table.name}.${key.name}`);
				excludedTargets.add(table.name).add(key.references);
				continue;
			}
			if (key.references === table.name || key.deferrable) continue;
			const nullable = held.length > 0 && held.every((c) => c.nullable);
			edges.push({ from: key.references, to: table.name, key, nullable });
		}
	}
	if (intoExcluded.length) {
		throw new RestorePlanError(
			'references_excluded_table',
			[...excludedTargets].sort(byText),
			intoExcluded.sort(byText)
		);
	}

	const late = new Set<Edge>();
	for (const component of components(names, edges)) {
		if (component.length > 1) breakCycles(component, edges, late);
	}

	// Kahn's algorithm, always taking the first ready table by name.
	const waiting = new Map<string, number>(names.map((n) => [n, 0]));
	const next = new Map<string, string[]>(names.map((n) => [n, []]));
	for (const e of edges) {
		if (late.has(e)) continue;
		waiting.set(e.to, waiting.get(e.to)! + 1);
		next.get(e.from)!.push(e.to);
	}
	const ready = names.filter((n) => waiting.get(n) === 0);
	const order: string[] = [];
	while (ready.length) {
		ready.sort(byText);
		const table = ready.shift()!;
		order.push(table);
		for (const to of next.get(table)!) {
			const count = waiting.get(to)! - 1;
			waiting.set(to, count);
			if (count === 0) ready.push(to);
		}
	}

	return {
		order,
		late: [...late]
			.map((e) => ({ table: e.to, columns: [...e.key.columns], fk: e.key.name }))
			.sort((a, b) => byText(a.table, b.table) || byText(a.fk, b.fk))
	};
}
