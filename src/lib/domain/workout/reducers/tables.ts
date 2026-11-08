/**
 * One reducer table per workout kind, so each workout route ships only its own (the offline
 * workout sync ADR):
 * - strengthTable (/workout): core, custom exercises, sets and structure
 * - runTable (/workout/run): core and run, in run.ts, so no other route's chunks carry the run
 *   family
 * - otherTable (/workout/session): core and other
 * Each also has the device actions. A table is typed over its kind's mutation types
 * (MUTATION_RULES), so a missing case fails pnpm check, and no table takes another kind's family.
 */
import type { ReducerTable } from '../project.ts';
import { core, customExercises } from './core.ts';
import { device } from './device.ts';
import { other } from './other.ts';
import { sets } from './sets.ts';
import { structure, structureSlot } from './structure.ts';

/**
 * Families as one table's cases. Each call is marked pure: a bundler keeps an object spread it
 * cannot prove free of getters, and with it the family, so a route would ship every table.
 */
const merge = <A, B, C = object, D = object>(a: A, b: B, c?: C, d?: D) =>
	Object.assign({}, a, b, c, d) as A & B & C & D;

export const strengthTable: ReducerTable<'strength'> = {
	kind: 'strength',
	mutations: /* @__PURE__ */ merge(core, customExercises, sets, structure),
	local: device,
	slot: structureSlot
};

export const otherTable: ReducerTable<'other'> = {
	kind: 'other',
	mutations: /* @__PURE__ */ merge(core, other),
	local: device
};
