/**
 * The db:explain gate on canned EXPLAIN (FORMAT JSON) plans: a relation is large or small by its
 * size after ANALYZE, a sequential scan of a large relation fails wherever it sits in the plan,
 * and a builder's declared index must be used when its table is large. Small relations' plans
 * pass whatever they scan, because a sequential scan is the right plan there.
 */
import { describe, expect, it } from 'vitest';
import { ANALYTICS_INDEXES } from '../../src/lib/server/db/queries/analytics';
import {
	checkPlan,
	LARGE_PAGES,
	LARGE_TUPLES,
	PENDING_INDEX_SLOT,
	pendingOf,
	scansOf,
	sizeClass,
	WHOLE_READ_SHARE,
	wholeReadsOf,
	type Catalog,
	type ExpectedIndex,
	type PlanNode
} from './plan-check';

const LARGE = { tuples: 16_000, pages: 220 };
const SMALL = { tuples: 1_100, pages: 30 };

function catalog(setRecords: { tuples: number; pages: number }): Catalog {
	return {
		relations: new Map([
			['set_records', setRecords],
			['workouts', SMALL],
			['exercises', { tuples: 191, pages: 9 }]
		]),
		indexes: new Map([
			['set_records_exercise_history_idx', 'set_records'],
			['set_records_owner_performed_idx', 'set_records'],
			['workouts_pkey', 'workouts'],
			['workouts_owner_started_idx', 'workouts'],
			['exercises_pkey', 'exercises']
		])
	};
}

/** lastPerformances gone wrong: the sets read by a Seq Scan three joins down. */
const nestedSeqScan: PlanNode = {
	'Node Type': 'Sort',
	Plans: [
		{
			'Node Type': 'Nested Loop',
			Plans: [
				{
					'Node Type': 'Hash Join',
					Plans: [
						{ 'Node Type': 'Seq Scan', 'Relation Name': 'set_records', Alias: 'set_records' },
						{
							'Node Type': 'Hash',
							Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'workouts', Alias: 'workouts' }]
						}
					]
				},
				{
					'Node Type': 'Index Scan',
					'Relation Name': 'exercises',
					'Index Name': 'exercises_pkey'
				}
			]
		}
	]
};

/** exerciseHistory as intended: one range of the history index. */
const historyScan: PlanNode = {
	'Node Type': 'Limit',
	Plans: [
		{
			'Node Type': 'Index Scan',
			'Relation Name': 'set_records',
			'Index Name': 'set_records_exercise_history_idx'
		}
	]
};

describe('sizeClass', () => {
	it('is large from LARGE_TUPLES rows or LARGE_PAGES pages, and small below both', () => {
		expect(sizeClass({ tuples: LARGE_TUPLES - 1, pages: LARGE_PAGES - 1 })).toBe('small');
		expect(sizeClass({ tuples: LARGE_TUPLES, pages: 1 })).toBe('large');
		expect(sizeClass({ tuples: 10, pages: LARGE_PAGES })).toBe('large');
		// Never analysed: Postgres reports -1 rows.
		expect(sizeClass({ tuples: -1, pages: 0 })).toBe('small');
	});
});

describe('checkPlan', () => {
	it('fails a Seq Scan on a large relation nested under joins', () => {
		const problems = checkPlan(nestedSeqScan, [], catalog(LARGE));
		expect(problems).toEqual(['Seq Scan on set_records, a large relation (16000 rows, 220 pages)']);
	});

	it('passes the same plan when the relation is small', () => {
		expect(checkPlan(nestedSeqScan, ['set_records_exercise_history_idx'], catalog(SMALL))).toEqual(
			[]
		);
	});

	it('fails when the declared index of a large relation is not used', () => {
		const otherIndex: PlanNode = {
			'Node Type': 'Limit',
			Plans: [
				{
					'Node Type': 'Index Scan',
					'Relation Name': 'set_records',
					'Index Name': 'set_records_owner_performed_idx'
				}
			]
		};
		expect(checkPlan(otherIndex, ['set_records_exercise_history_idx'], catalog(LARGE))).toEqual([
			'set_records_exercise_history_idx is not used on set_records, a large relation (16000 rows, 220 pages)'
		]);
		expect(checkPlan(historyScan, ['set_records_exercise_history_idx'], catalog(LARGE))).toEqual(
			[]
		);
	});

	it('counts a Bitmap Index Scan, whose heap scan names the relation, as using the index', () => {
		const bitmap: PlanNode = {
			'Node Type': 'Bitmap Heap Scan',
			'Relation Name': 'set_records',
			Plans: [{ 'Node Type': 'Bitmap Index Scan', 'Index Name': 'set_records_owner_performed_idx' }]
		};
		expect(checkPlan(bitmap, ['set_records_owner_performed_idx'], catalog(LARGE))).toEqual([]);
	});

	it('finds a Seq Scan inside an InitPlan', () => {
		const initPlan: PlanNode = {
			...historyScan,
			Plans: [
				...historyScan.Plans!,
				{
					'Node Type': 'Seq Scan',
					'Parent Relationship': 'InitPlan',
					'Relation Name': 'set_records',
					Alias: 'cursor'
				}
			]
		};
		expect(checkPlan(initPlan, ['set_records_exercise_history_idx'], catalog(LARGE))).toEqual([
			'Seq Scan on set_records, a large relation (16000 rows, 220 pages)'
		]);
	});

	it('fails a declared index that does not exist', () => {
		expect(checkPlan(historyScan, ['set_records_history_idx'], catalog(SMALL))).toEqual([
			'set_records_history_idx is not an index of this database'
		]);
	});
});

describe('pending indexes', () => {
	const seqScan: PlanNode = {
		'Node Type': 'Seq Scan',
		'Relation Name': 'set_records',
		Alias: 'set_records'
	};
	const pending = {
		index: 'set_records_owner_status_idx',
		table: 'set_records',
		pendingIndex: PENDING_INDEX_SLOT
	} as const;

	it('records a large relation scanned without its index while the index waits for analytics-explain', () => {
		expect(PENDING_INDEX_SLOT).toBe('analytics-explain');
		expect(checkPlan(seqScan, [pending], catalog(LARGE))).toEqual([]);
		expect(pendingOf([pending, 'workouts_pkey'], catalog(LARGE))).toEqual([pending]);
	});

	it('refuses a pending index that names another slot', () => {
		const elsewhere = { ...pending, pendingIndex: 'coach-explain' } as unknown as ExpectedIndex;
		expect(pendingOf([elsewhere], catalog(LARGE))).toEqual([]);
		expect(checkPlan(seqScan, [elsewhere], catalog(LARGE))).toEqual([
			"set_records_owner_status_idx may wait only for 'analytics-explain', not 'coach-explain'",
			'Seq Scan on set_records, a large relation (16000 rows, 220 pages)',
			'set_records_owner_status_idx is not an index of this database'
		]);
	});

	it('gates the index like any other once a migration has added it', () => {
		const added = { ...pending, index: 'set_records_owner_performed_idx' };
		expect(pendingOf([added], catalog(LARGE))).toEqual([]);
		expect(checkPlan(seqScan, [added], catalog(LARGE))).toEqual([
			'Seq Scan on set_records, a large relation (16000 rows, 220 pages)',
			'set_records_owner_performed_idx is not used on set_records, a large relation (16000 rows, 220 pages)'
		]);
	});

	it('waives only the pending index table: a Seq Scan on another large relation still fails', () => {
		const join: PlanNode = {
			'Node Type': 'Hash Join',
			Plans: [seqScan, { 'Node Type': 'Seq Scan', 'Relation Name': 'workouts', Alias: 'w' }]
		};
		const big = {
			...catalog(LARGE),
			relations: new Map([
				['set_records', LARGE],
				['workouts', LARGE]
			])
		};
		expect(checkPlan(join, [pending], big)).toEqual([
			'Seq Scan on workouts, a large relation (16000 rows, 220 pages)'
		]);
	});

	it('finds every ANALYTICS_INDEXES entry a real index name or a pending one for analytics-explain', () => {
		const entries = Object.values(ANALYTICS_INDEXES).flatMap((entry): unknown[] =>
			typeof entry === 'object' && !('pendingIndex' in entry) ? Object.values(entry) : [entry]
		);
		expect(entries.length).toBeGreaterThanOrEqual(8);
		for (const entry of entries) {
			if (typeof entry === 'string') expect(entry).toMatch(/^[a-z_]+_(idx|uq|pkey|pk)$/);
			else expect(entry).toMatchObject({ pendingIndex: PENDING_INDEX_SLOT });
		}
	});
});

describe('whole reads', () => {
	const seq = (rows: number, loops: number): PlanNode => ({
		'Node Type': 'Seq Scan',
		'Relation Name': 'set_records',
		'Actual Rows': rows,
		'Actual Loops': loops
	});
	const read = (rows: number, loops: number): PlanNode => ({
		'Node Type': 'Hash Join',
		Plans: [
			seq(rows, loops),
			{ 'Node Type': 'Index Scan', 'Relation Name': 'workouts', 'Index Name': 'workouts_pkey' }
		]
	});
	const declared = ['set_records_owner_performed_idx'];
	const optedIn: ExpectedIndex[] = [...declared, { wholeRead: 'set_records' }];
	const seqScanFailure = 'Seq Scan on set_records, a large relation (16000 rows, 220 pages)';
	const unusedIndex =
		'set_records_owner_performed_idx is not used on set_records, a large relation (16000 rows, 220 pages)';

	it('records one Seq Scan returning at least WHOLE_READ_SHARE of an opted-in table, its index unused', () => {
		expect(WHOLE_READ_SHARE).toBe(0.5);
		expect(wholeReadsOf(read(12_000, 1), optedIn, catalog(LARGE))).toMatchObject([
			{ relation: 'set_records', share: 0.75 }
		]);
		expect(checkPlan(read(12_000, 1), optedIn, catalog(LARGE))).toEqual([]);
		expect(checkPlan(read(8_000, 1), optedIn, catalog(LARGE))).toEqual([]);
	});

	it('gates the same whole read when the case has not opted its table in', () => {
		expect(wholeReadsOf(read(12_000, 1), declared, catalog(LARGE))).toEqual([]);
		expect(checkPlan(read(12_000, 1), declared, catalog(LARGE))).toEqual([
			seqScanFailure,
			unusedIndex
		]);
	});

	it('still fails a Seq Scan returning less, and its unused index', () => {
		expect(wholeReadsOf(read(7_999, 1), optedIn, catalog(LARGE))).toEqual([]);
		expect(checkPlan(read(7_999, 1), optedIn, catalog(LARGE))).toEqual([
			seqScanFailure,
			unusedIndex
		]);
	});

	it('never counts a Seq Scan repeated in a loop, or one without actual rows, as a whole read', () => {
		expect(wholeReadsOf(read(9_000, 40), optedIn, catalog(LARGE))).toEqual([]);
		expect(checkPlan(read(9_000, 40), [{ wholeRead: 'set_records' }], catalog(LARGE))).toEqual([
			seqScanFailure
		]);
		expect(wholeReadsOf(nestedSeqScan, optedIn, catalog(LARGE))).toEqual([]);
	});

	it('waives only the whole-read node: a looped Seq Scan of the same table still fails', () => {
		const both: PlanNode = { 'Node Type': 'Nested Loop', Plans: [seq(12_000, 1), seq(9_000, 40)] };
		expect(checkPlan(both, [{ wholeRead: 'set_records' }], catalog(LARGE))).toEqual([
			seqScanFailure
		]);
	});
});

describe('scansOf', () => {
	it('lists every scan with its relation, index and size class, small relations included', () => {
		expect(scansOf(nestedSeqScan, catalog(LARGE))).toEqual([
			{ node: 'Seq Scan', relation: 'set_records', index: null, size: 'large' },
			{ node: 'Seq Scan', relation: 'workouts', index: null, size: 'small' },
			{ node: 'Index Scan', relation: 'exercises', index: 'exercises_pkey', size: 'small' }
		]);
	});
});
