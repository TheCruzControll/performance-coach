/**
 * The db:explain gate on canned EXPLAIN (FORMAT JSON) plans: a relation is large or small by its
 * size after ANALYZE, a sequential scan of a large relation fails wherever it sits in the plan,
 * and a builder's declared index must be used when its table is large. Small relations' plans
 * pass whatever they scan, because a sequential scan is the right plan there.
 */
import { describe, expect, it } from 'vitest';
import {
	checkPlan,
	LARGE_PAGES,
	LARGE_TUPLES,
	scansOf,
	sizeClass,
	type Catalog,
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

describe('scansOf', () => {
	it('lists every scan with its relation, index and size class, small relations included', () => {
		expect(scansOf(nestedSeqScan, catalog(LARGE))).toEqual([
			{ node: 'Seq Scan', relation: 'set_records', index: null, size: 'large' },
			{ node: 'Seq Scan', relation: 'workouts', index: null, size: 'small' },
			{ node: 'Index Scan', relation: 'exercises', index: 'exercises_pkey', size: 'small' }
		]);
	});
});
