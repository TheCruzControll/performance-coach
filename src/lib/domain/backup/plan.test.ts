import { describe, expect, it } from 'vitest';
import { planRestore, RestorePlanError } from './plan';
import type { Catalog, CatalogForeignKey, CatalogTable } from './plan';

interface KeySpec {
	/** The referenced table. */
	to: string;
	columns?: string[];
	nullable?: boolean;
	deferrable?: boolean;
	name?: string;
}

/** A table with an `id` primary key and one column per key, named after the key. */
function table(name: string, keys: KeySpec[] = []): CatalogTable {
	const foreignKeys: CatalogForeignKey[] = keys.map((k) => {
		const columns = k.columns ?? [`${k.to}_id`];
		return {
			name: k.name ?? `${name}_${columns.join('_')}_${k.to}_fk`,
			columns,
			references: k.to,
			referencedColumns: columns.map(() => 'id'),
			deferrable: k.deferrable ?? false
		};
	});
	const columns = [...new Set(foreignKeys.flatMap((k) => k.columns))].map((column) => ({
		name: column,
		type: 'uuid',
		nullable: keys.find((k, i) => foreignKeys[i]!.columns.includes(column))?.nullable ?? false,
		generated: false,
		identity: null
	}));
	return {
		name,
		columns: [
			{ name: 'id', type: 'uuid', nullable: false, generated: false, identity: null },
			...columns
		],
		primaryKey: ['id'],
		foreignKeys
	};
}

const catalog = (...tables: CatalogTable[]): Catalog => ({ tables, sequences: [] });

/** The thrown error, for asserting its code and names. */
function refusal(run: () => unknown): RestorePlanError {
	try {
		run();
	} catch (error) {
		if (error instanceof RestorePlanError) return error;
		throw error;
	}
	throw new Error('planRestore did not refuse');
}

/** programs ↔ program_versions as migrations 0008 and 0009 build them. */
const programs = () => [
	table('users'),
	table('programs', [
		{ to: 'users', columns: ['user_id'] },
		{
			to: 'program_versions',
			columns: ['current_version_id'],
			nullable: true,
			name: 'programs_current_version_id_program_versions_id_fk'
		}
	]),
	table('program_versions', [
		{ to: 'programs', columns: ['program_id'] },
		{
			to: 'program_versions',
			columns: ['parent_version_id'],
			nullable: true,
			name: 'program_versions_parent_version_id_program_versions_id_fk'
		}
	]),
	table('prescriptions', [{ to: 'program_versions', columns: ['version_id'] }])
];

describe('planRestore: order', () => {
	it('puts a chain, a diamond and independent tables in dependency order, ties by name', () => {
		const plan = planRestore(
			catalog(
				table('zeta'),
				table('chain_c', [{ to: 'chain_b' }]),
				table('chain_b', [{ to: 'chain_a' }]),
				table('chain_a'),
				table('top'),
				table('right', [{ to: 'top' }]),
				table('left', [{ to: 'top' }]),
				table('bottom', [{ to: 'left' }, { to: 'right' }]),
				table('alpha')
			),
			[]
		);
		expect(plan).toEqual({
			order: ['alpha', 'chain_a', 'chain_b', 'chain_c', 'top', 'left', 'right', 'bottom', 'zeta'],
			late: []
		});
	});

	it('makes exactly programs.current_version_id late, and orders programs before versions', () => {
		const plan = planRestore(catalog(...programs()), []);
		expect(plan.late).toEqual([
			{
				table: 'programs',
				columns: ['current_version_id'],
				fk: 'programs_current_version_id_program_versions_id_fk'
			}
		]);
		expect(plan.order).toEqual(['users', 'programs', 'program_versions', 'prescriptions']);
	});

	it('loads a self-referencing table in one statement: nothing is late, even NOT NULL', () => {
		const plan = planRestore(
			catalog(
				table('nodes', [{ to: 'nodes', columns: ['parent_id'], nullable: false }]),
				table('leaves', [{ to: 'nodes' }])
			),
			[]
		);
		expect(plan).toEqual({ order: ['nodes', 'leaves'], late: [] });
	});

	it('lets a deferrable cycle load in name order with nothing late', () => {
		const plan = planRestore(
			catalog(
				table('b', [{ to: 'a', deferrable: true }]),
				table('a', [{ to: 'b', deferrable: true }])
			),
			[]
		);
		expect(plan).toEqual({ order: ['a', 'b'], late: [] });
	});

	it('breaks a cycle on the nullable key with the fewest columns', () => {
		const plan = planRestore(
			catalog(
				table('a', [{ to: 'b', columns: ['b_one', 'b_two'], nullable: true }]),
				table('b', [{ to: 'a', columns: ['a_id'], nullable: true }])
			),
			[]
		);
		expect(plan.late).toEqual([{ table: 'b', columns: ['a_id'], fk: 'b_a_id_a_fk' }]);
		expect(plan.order).toEqual(['b', 'a']);
	});

	it('breaks every cycle of a three-table component, and only as many keys as it needs', () => {
		// a needs c, b needs a and c, c needs b: two cycles, b–c and a–b–c.
		const plan = planRestore(
			catalog(
				table('a', [{ to: 'c', nullable: true }]),
				table('b', [{ to: 'a' }, { to: 'c', nullable: true }]),
				table('c', [{ to: 'b' }])
			),
			[]
		);
		expect(plan.late).toEqual([
			{ table: 'a', columns: ['c_id'], fk: 'a_c_id_c_fk' },
			{ table: 'b', columns: ['c_id'], fk: 'b_c_id_c_fk' }
		]);
		expect(plan.order).toEqual(['a', 'b', 'c']);
	});
});

describe('planRestore: refusals', () => {
	it('refuses a NOT NULL two-table cycle, naming its tables and keys', () => {
		const error = refusal(() =>
			planRestore(catalog(table('users'), table('a', [{ to: 'b' }]), table('b', [{ to: 'a' }])), [])
		);
		expect(error.code).toBe('unbreakable_cycle');
		expect(error.tables).toEqual(['a', 'b']);
		expect(error.foreignKeys).toEqual(['a.a_b_id_b_fk', 'b.b_a_id_a_fk']);
		expect(error.message).toContain('a, b');
		expect(error.message).toContain('a.a_b_id_b_fk');
	});

	it('refuses a cycle whose only nullable key also holds a NOT NULL column', () => {
		const partly = table('a', [{ to: 'b', columns: ['b_one', 'b_two'] }]);
		partly.columns[1]!.nullable = true;
		const error = refusal(() => planRestore(catalog(partly, table('b', [{ to: 'a' }])), []));
		expect(error.code).toBe('unbreakable_cycle');
		expect(error.tables).toEqual(['a', 'b']);
	});

	it('refuses a key into an excluded table, naming both tables and the key', () => {
		const error = refusal(() =>
			planRestore(
				catalog(
					table('users'),
					table('auth_sessions', [{ to: 'users' }]),
					table('audit', [{ to: 'auth_sessions', nullable: true }])
				),
				['auth_sessions']
			)
		);
		expect(error.code).toBe('references_excluded_table');
		expect(error.tables).toEqual(['audit', 'auth_sessions']);
		expect(error.foreignKeys).toEqual(['audit.audit_auth_sessions_id_auth_sessions_fk']);
	});

	it('leaves out an excluded table that only references others, and ignores unknown names', () => {
		const plan = planRestore(catalog(table('users'), table('auth_sessions', [{ to: 'users' }])), [
			'auth_sessions',
			'email_sign_in_links'
		]);
		expect(plan).toEqual({ order: ['users'], late: [] });
	});

	it('throws a RangeError for a malformed catalog', () => {
		expect(() => planRestore(catalog(table('a'), table('a')), [])).toThrow(RangeError);
		expect(() => planRestore(catalog(table('a', [{ to: 'missing' }])), [])).toThrow(RangeError);
		const broken = table('a', [{ to: 'b' }]);
		broken.columns.pop();
		expect(() => planRestore(catalog(broken, table('b')), [])).toThrow(RangeError);
	});
});

/** mulberry32, so every graph is reproducible from its seed. */
function random(seed: number) {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = Math.imul(state ^ (state >>> 15), state | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
	};
}

function shuffled<T>(items: readonly T[], next: () => number): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[out[i], out[j]] = [out[j]!, out[i]!];
	}
	return out;
}

/** Up to 14 tables and 3 keys each, any of them nullable, deferrable or a self-reference. */
function randomCatalog(seed: number): Catalog {
	const next = random(seed);
	const count = 1 + Math.floor(next() * 14);
	const names = Array.from({ length: count }, (_, i) => `t${String(i).padStart(2, '0')}`);
	return catalog(
		...names.map((name) => {
			const keys = Array.from({ length: Math.floor(next() * 4) }, (_, k) => ({
				to: names[Math.floor(next() * count)]!,
				columns: [`k${k}`],
				nullable: next() < 0.6,
				deferrable: next() < 0.15
			}));
			return table(name, keys);
		})
	);
}

describe('planRestore: properties over 200 seeded random graphs', () => {
	it('loads every constraining key’s target first, and ignores the input order', () => {
		let planned = 0;
		let withLate = 0;
		for (let seed = 1; seed <= 200; seed++) {
			const input = randomCatalog(seed);
			let plan;
			try {
				plan = planRestore(input, []);
			} catch (error) {
				expect(error).toBeInstanceOf(RestorePlanError);
				expect((error as RestorePlanError).code).toBe('unbreakable_cycle');
				continue;
			}
			planned++;
			if (plan.late.length) withLate++;
			expect([...plan.order].sort()).toEqual(input.tables.map((t) => t.name).sort());
			const position = new Map(plan.order.map((name, i) => [name, i]));
			const late = new Set(plan.late.map((l) => `${l.table}.${l.fk}`));
			for (const t of input.tables) {
				for (const key of t.foreignKeys) {
					if (key.deferrable || key.references === t.name || late.has(`${t.name}.${key.name}`)) {
						continue;
					}
					expect(position.get(key.references)!, `${t.name}.${key.name}`).toBeLessThan(
						position.get(t.name)!
					);
				}
			}
			for (const l of plan.late) {
				const holder = input.tables.find((t) => t.name === l.table)!;
				expect(l.columns.every((c) => holder.columns.find((col) => col.name === c)?.nullable)).toBe(
					true
				);
			}

			const next = random(seed * 7919);
			const reordered = catalog(
				...shuffled(input.tables, next).map((t) => ({
					...t,
					foreignKeys: shuffled(t.foreignKeys, next)
				}))
			);
			expect(planRestore(reordered, [])).toEqual(plan);
		}
		// The generator must exercise both outcomes, or the property proves little.
		expect(planned).toBeGreaterThan(50);
		expect(withLate).toBeGreaterThan(20);
	});
});
