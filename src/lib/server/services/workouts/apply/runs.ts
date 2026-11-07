/**
 * run.log and run.segment, mapped from wire format v1 onto M3's run services
 * (services/training/log.ts) in the mutation's transaction, by the contract's identity rule.
 *
 * - run.log sets the run's own fields it carries (distance, duration, HR, RPE, notes), absolutely:
 *   logRun while the workout has no run record, editRun after, with the stored values for the
 *   fields it leaves out. A segment may have made the record first, its totals empty.
 * - run.segment's first send (id === entityId) adds the segment under its client id
 *   (addRunSegment, which makes the run's record when there is none); every later send replaces
 *   its values (editRunSegment), and is deferred while the segment has not arrived.
 * - An edit that changes nothing writes nothing; a real one writes one training_audit row.
 * - The wire carries metres, which M3 stores through M1's toMetres. M3 takes a distance to three
 *   decimals, so a device's converted miles (3.1 mi is 4988.9664 m) are sent to the millimetre.
 */
import type { RunFields } from '../../../../domain/workout/index';
import { cleanFloat } from '../../../../domain/units';
import type { RunRow } from '../../../db/repositories/training-log';
import { addRunSegment, editRun, editRunSegment, logRun } from '../../training/log';
import type { Handlers } from './handler';

/** M3 takes a distance to three decimals: metres are sent to the millimetre. */
const MILLIMETRES = 3;

const RUN_FIELDS = [
	'distanceMetres',
	'durationSeconds',
	'avgHr',
	'rpe',
	'notes'
] as const satisfies readonly (keyof RunFields)[];

/** A distance in metres as M3's services take one. */
const distanceOf = (metres: number | null | undefined) =>
	metres === undefined
		? undefined
		: metres === null
			? null
			: { value: cleanFloat(metres, MILLIMETRES), unit: 'm' as const };

/** M3's input for values in the wire's fields. */
function serviceValues<T extends { distanceMetres?: number | null }>(values: T) {
	const { distanceMetres, ...rest } = values;
	const distance = distanceOf(distanceMetres);
	return { ...rest, ...(distance !== undefined && { distance }) };
}

/** The fields a run.log carries, and nothing it leaves out. */
const carried = (payload: Partial<RunFields>): Partial<RunFields> =>
	Object.fromEntries(
		RUN_FIELDS.filter((key) => payload[key] !== undefined).map((key) => [key, payload[key]])
	);

/** A stored run's own values, in the wire's fields. */
const ownValues = (run: RunRow): RunFields => ({
	distanceMetres: run.distanceMetres,
	durationSeconds: run.durationSeconds,
	avgHr: run.avgHr,
	rpe: run.rpe,
	notes: run.notes
});

export const runHandlers: Handlers<'run.log' | 'run.segment'> = {
	async 'run.log'(m, { ownerId, deps }) {
		const given = carried(m.payload);
		const input = { workoutClientId: m.workoutId, ...serviceValues(given) };
		const logged = await logRun(ownerId, input, deps);
		if (!logged.duplicate) return;
		// The record was there (an earlier run.log, or a segment): set what this one carries.
		const values = serviceValues({ ...ownValues(logged.run), ...given });
		await editRun(ownerId, m.workoutId, values, deps);
	},

	async 'run.segment'(m, { ownerId, deps }) {
		const values = serviceValues(m.payload);
		if (m.id === m.entityId) {
			const segment = { clientMutationId: m.entityId, ...values };
			await addRunSegment(ownerId, m.workoutId, segment, deps);
			return;
		}
		await editRunSegment(ownerId, m.entityId, values, deps);
	}
};
