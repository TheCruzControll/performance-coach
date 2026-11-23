/**
 * The owner's weigh-ins (body_weight_entries, one per owner per day): log, replace, edit, delete,
 * and undo a coach write. Every write is scoped to the owner and runs in one transaction. "Today"
 * is the owner's calendar day in their time zone (profile.timeZone), so a weigh-in at 23:30 in Los
 * Angeles belongs to that day whatever its UTC date.
 */
import type { IsoDate } from '../../../domain/calendar';
import { localDay } from '../../../domain/dates';
import { WEIGHT_SOURCES, type WeightSource } from '../../../domain/profile/catalog';
import { weightEntrySchema } from '../../../domain/profile/schemas';
import {
	createProfileRepository,
	createWeightRepository,
	getDb,
	type Executor,
	type WeightEntryRow,
	type WeightReplaced
} from '../../db';
import { measure } from '../../observability/timing';
import { parseWith, ProfileInputError, ProfileNotFoundError } from '../profile/shared';

/**
 * Who writes (`source`, default 'log' for the owner's screens), the clock and the database. A
 * coach write names its run: Undo matches the entry on it.
 */
export interface WeightDeps {
	db?: Executor;
	now?: () => Date;
	source?: WeightSource;
	runId?: string;
}

/**
 * Undo refused: 'gone' when the entry no longer exists, 'changed' when it no longer holds the
 * coach write Undo was asked about (edited, deleted by the owner, or written by another run).
 */
export class WeightUndoError extends Error {
	readonly reason: 'changed' | 'gone';

	constructor(reason: 'changed' | 'gone') {
		super(
			reason === 'gone'
				? 'That weigh-in is gone'
				: 'That weigh-in has changed since the coach logged it'
		);
		this.name = 'WeightUndoError';
		this.reason = reason;
	}
}

interface Resolved {
	db: Executor;
	now: () => Date;
	source: WeightSource;
	runId: string | null;
}

function resolve(deps: WeightDeps): Resolved {
	return {
		db: deps.db ?? getDb(),
		now: deps.now ?? (() => new Date()),
		source: deps.source ?? 'log',
		runId: deps.runId ?? null
	};
}

function isWeightSource(value: string): value is WeightSource {
	return (WEIGHT_SOURCES as readonly string[]).includes(value);
}

/** The day a form or the coach left out (absent or blank) is today. */
function withDay(input: unknown, today: IsoDate): unknown {
	if (typeof input !== 'object' || input === null) return input;
	const entry = input as Record<string, unknown>;
	const day = entry.measuredOn;
	return day === undefined || day === null || day === '' ? { ...entry, measuredOn: today } : input;
}

/** The entry a day held, as a coach write remembers it for Undo. */
function replacedOf(row: WeightEntryRow): WeightReplaced {
	return { value: row.value, unit: row.unit, source: row.source };
}

/**
 * Record the owner's weigh-in for a day (today unless the input names another). A day that already
 * has one is replaced: the row keeps its id, and the entry it held comes back as `replaced`. A coach
 * write (source 'coach', with its runId) keeps that earlier entry so Undo can restore it. Any other
 * source clears run_id and replaced.
 */
export async function logWeight(
	ownerId: string,
	input: unknown,
	deps: WeightDeps = {}
): Promise<{ entry: WeightEntryRow; replaced: WeightEntryRow | null }> {
	const { db, now, source, runId } = resolve(deps);
	if (source === 'coach' && runId === null) {
		throw new Error('A coach weigh-in needs the run that made it');
	}
	return measure('db', () =>
		db.transaction(async (tx) => {
			const at = now();
			const profile = await createProfileRepository(tx).ensureProfile(ownerId);
			const today = localDay(at, profile.timeZone);
			const weigh = parseWith(weightEntrySchema(today), withDay(input, today));
			const repo = createWeightRepository(tx);
			const { entry, previous } = await repo.upsertForDay(
				ownerId,
				{
					value: weigh.value,
					unit: weigh.unit,
					measuredOn: weigh.measuredOn,
					source,
					runId: source === 'coach' ? runId : null,
					replaced: null
				},
				at
			);
			if (previous === null || source !== 'coach') return { entry, replaced: previous };
			// Read under the row lock upsertForDay took, so the remembered entry is the one replaced.
			const remembered = await repo.update(
				ownerId,
				entry.id,
				{ replaced: replacedOf(previous) },
				at
			);
			return { entry: remembered ?? entry, replaced: previous };
		})
	);
}

/**
 * Change a weigh-in's value, unit or day. Moving it onto a day that already has one is refused at
 * `measuredOn`. An edit is a new write by the caller, so it clears run_id and replaced: a coach
 * entry the owner changes is no longer one Undo can take back.
 */
export async function editWeight(
	ownerId: string,
	id: number,
	input: unknown,
	deps: WeightDeps = {}
): Promise<WeightEntryRow> {
	const { db, now, source } = resolve(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const at = now();
			const profile = await createProfileRepository(tx).ensureProfile(ownerId);
			const today = localDay(at, profile.timeZone);
			const weigh = parseWith(weightEntrySchema(today), withDay(input, today));
			const repo = createWeightRepository(tx);
			const current = await repo.getById(ownerId, id);
			if (!current) throw new ProfileNotFoundError('Weigh-in');
			if (
				weigh.measuredOn !== current.measuredOn &&
				(await repo.listRange(ownerId, weigh.measuredOn, weigh.measuredOn)).length > 0
			) {
				throw new ProfileInputError({ measuredOn: 'That day already has a weigh-in' });
			}
			const row = await repo.update(
				ownerId,
				id,
				{
					value: weigh.value,
					unit: weigh.unit,
					measuredOn: weigh.measuredOn,
					source,
					runId: null,
					replaced: null
				},
				at
			);
			if (!row) throw new ProfileNotFoundError('Weigh-in');
			return row;
		})
	);
}

/** Remove a weigh-in. Missing, or another owner's, is ProfileNotFoundError. */
export async function deleteWeight(
	ownerId: string,
	id: number,
	deps: WeightDeps = {}
): Promise<void> {
	const { db } = resolve(deps);
	const row = await measure('db', () => createWeightRepository(db).delete(ownerId, id));
	if (!row) throw new ProfileNotFoundError('Weigh-in');
}

/**
 * Undo a coach write. Only the entry holding that run's write can be undone: a replaced entry
 * comes back as it was (value, unit and source, on the same day), and a day the coach newly filled
 * loses its entry. Returns the entry that stands afterwards, or null when the day is empty again.
 * Throws WeightUndoError: 'gone' with no entry, 'changed' when it is no longer the coach's write.
 */
export async function undoCoachWeight(
	ownerId: string,
	id: number,
	runId: string,
	deps: WeightDeps = {}
): Promise<{ entry: WeightEntryRow | null }> {
	const { db, now } = resolve(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createWeightRepository(tx);
			const current = await repo.getById(ownerId, id);
			if (!current) throw new WeightUndoError('gone');
			if (current.source !== 'coach' || current.runId !== runId) {
				throw new WeightUndoError('changed');
			}
			const at = now();
			if (!current.replaced) {
				if (!(await repo.delete(ownerId, id))) throw new WeightUndoError('gone');
				return { entry: null };
			}
			const earlier = current.replaced;
			if (!isWeightSource(earlier.source)) {
				throw new Error(`Unknown weigh-in source in an Undo record: ${earlier.source}`);
			}
			const restored = await repo.update(
				ownerId,
				id,
				{
					value: earlier.value,
					unit: earlier.unit,
					source: earlier.source,
					runId: null,
					replaced: null
				},
				at
			);
			if (!restored) throw new WeightUndoError('gone');
			return { entry: restored };
		})
	);
}
