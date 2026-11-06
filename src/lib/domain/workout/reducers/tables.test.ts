import { describe, expect, expectTypeOf, it } from 'vitest';
import { MUTATION_RULES, MUTATION_TYPES } from '../mutations';
import type { LocalAction, MutationTypeFor } from '../mutations';
import type { SessionKind } from '../../training/types';
import { otherTable, runTable, strengthTable } from './tables';

const LOCAL_TYPES: LocalAction['type'][] = [
	'goTo',
	'draft',
	'exercise.add',
	'kit.attach',
	'rest.start',
	'rest.add',
	'rest.pause',
	'rest.resume',
	'rest.reset',
	'rest.skip',
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
});
