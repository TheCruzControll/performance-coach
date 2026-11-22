import { describe, expect, expectTypeOf, it } from 'vitest';
import { createMutation, MUTATION_RULES, MUTATION_TYPES } from '../mutations';
import type { LocalAction, MutationTypeFor } from '../mutations';
import type { SessionKind } from '../../training/types';
import { runTable } from './run';
import { strengthTable } from './tables';
import { otherTable } from './other';

const AT = '2026-11-06T18:00:00.000Z';
const W = '00000000-0000-4000-8000-0000000000a1';

const LOCAL_TYPES: LocalAction['type'][] = [
	'goTo',
	'draft',
	'session.draft',
	'exercise.add',
	'kit.attach',
	'rest.start',
	'rest.add',
	'rest.pause',
	'rest.resume',
	'rest.reset',
	'rest.skip',
	'rest.clear',
	'stopwatch.start',
	'stopwatch.pause',
	'stopwatch.resume',
	'stopwatch.reset'
];

const typesOf = (kind: SessionKind) =>
	MUTATION_TYPES.filter((type) => (MUTATION_RULES[type].kinds as readonly string[]).includes(kind));

describe('reducer tables', () => {
	it("hold exactly their kind's mutation types, and every device action", () => {
		for (const table of [strengthTable, runTable, otherTable]) {
			expect(Object.keys(table.mutations).sort(), table.kind).toEqual(typesOf(table.kind).sort());
			expect(Object.keys(table.local).sort(), table.kind).toEqual([...LOCAL_TYPES].sort());
		}
		expect(Object.keys(strengthTable.mutations)).not.toContain('run.log');
		expect(Object.keys(runTable.mutations)).not.toContain('set.log');
		expect(Object.keys(otherTable.mutations)).not.toContain('exercise.create');
	});

	it("are typed over their kind's mutation types, so a missing or foreign case fails pnpm check", () => {
		expectTypeOf<keyof typeof strengthTable.mutations>().toEqualTypeOf<
			MutationTypeFor<'strength'>
		>();
		expectTypeOf<keyof typeof runTable.mutations>().toEqualTypeOf<MutationTypeFor<'run'>>();
		expectTypeOf<keyof typeof otherTable.mutations>().toEqualTypeOf<MutationTypeFor<'other'>>();

		// @ts-expect-error strength has no run.* reducer
		expect(strengthTable.mutations['run.log']).toBeUndefined();
		// @ts-expect-error a run has no set.* reducer
		expect(runTable.mutations['set.log']).toBeUndefined();
		// @ts-expect-error a session has no set.* reducer
		expect(otherTable.mutations['set.edit']).toBeUndefined();
	});

	it('record a pain report naming no exercise in a run and in a class, once', () => {
		const cases = [
			{
				table: runTable,
				start: {
					kind: 'run',
					title: 'Intervals',
					sessionType: 'interval_run',
					discipline: 'running'
				},
				position: 3
			},
			{
				table: otherTable,
				start: {
					kind: 'other',
					title: 'Muay Thai class',
					sessionType: 'muay_thai',
					discipline: 'muay_thai'
				},
				position: 1
			}
		] as const;
		for (const { table, start: adhoc, position } of cases) {
			const start = createMutation('workout.start', {
				workoutId: W,
				at: AT,
				payload: { ...adhoc, plannedSessionId: null, plannedLineage: null, programId: null }
			});
			const rows = table.mutations['workout.start'](null, start);
			const report = createMutation('pain.report', {
				workoutId: W,
				at: AT,
				payload: {
					position,
					plannedLineage: null,
					exerciseId: null,
					area: 'shin_calf',
					severity: 'moderate',
					action: 'ended_workout',
					substitutionId: null,
					note: null
				}
			});
			const once = table.mutations['pain.report'](rows, report);
			expect(once?.pain, table.kind).toEqual([
				{
					id: report.entityId,
					position,
					plannedLineage: null,
					exerciseId: null,
					area: 'shin_calf',
					severity: 'moderate',
					action: 'ended_workout',
					substitutionId: null,
					note: null,
					reportedAt: report.at,
					deletedAt: null
				}
			]);
			expect(table.mutations['pain.report'](once, report), table.kind).toBe(once);
		}
	});
});
