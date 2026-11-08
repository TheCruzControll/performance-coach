/**
 * The other family, other sessions only: other.log sets the session's record (entity
 * other:<workout>), creating it on the first send. Every send carries all the session's values,
 * so each replaces the record absolutely: a metric left out of a later send is no longer
 * recorded, and a replay changes nothing.
 *
 * otherTable (/workout/session's) lives here, not in tables.ts, which /workout loads: that route
 * ships none of the other family.
 */
import type { OtherFields } from '../mutations.ts';
import { onRows } from '../project.ts';
import type { MutationReducers, ReducerTable } from '../project.ts';
import type { CanonicalOther } from '../protocol.ts';
import { core } from './core.ts';
import { device } from './device.ts';

/** The session's values, and nothing else a payload or its metrics may hold. */
function recordOf({ kind, durationMinutes, rpe, metrics, notes }: OtherFields): CanonicalOther {
	return {
		kind,
		durationMinutes,
		rpe,
		metrics: metrics.map(({ key, label, unit, value }) => ({ key, label, unit, value })),
		notes
	};
}

export const other: MutationReducers<'other.log'> = {
	'other.log': onRows((rows, m) => ({ ...rows, other: recordOf(m.payload) }))
};

export const otherTable: ReducerTable<'other'> = {
	kind: 'other',
	mutations: { ...core, ...other },
	local: device
};
