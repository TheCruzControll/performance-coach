/**
 * Several program edits as one version (PRD §14, ADR 0010): what accepting the coach's
 * program_adjustment or workout_update writes (services/coach/apply/program.ts). It composes M3's
 * edits unchanged: each op is planned by its edit's applier (./edits.ts) on the base version,
 * exactly as the owner's own edit would be, and reviseProgram writes them all as one version.
 *
 * - Every op is validated with M3's schemas (programOpSchema wraps them). An op that is invalid,
 *   or that its edit refuses, fails the whole batch: its field errors come back under `ops.n`,
 *   counted from 0 as zod paths are, and nothing is written.
 * - Each affected week is copied once, however many ops change it; every other week is shared.
 * - One decision per op, in order, decided by the coach, each with the proposal's rationale as
 *   its 'why' and the op's evidence beside the batch's (a review's rules or the owner keep each
 *   edit's own why), then the batch's one extra decision if it has one.
 * - A never-again swap records its dislike (source 'coach') in the revising transaction, under
 *   the preferences lock.
 * - A base that is no longer the current version is a ProgramConflictError.
 *
 * The ops are planned independently on the base, so two of them may not set the same field of
 * the same row to different values, nor move two sessions to the same day (each would number
 * that day on its own): the later op is refused with OPS_OVERLAP. Adjustments of one session
 * compose: after each, the session's rows with every change so far are checked whole (a row the
 * op makes invalid is refused at that op) and its estimate and load are worked out again.
 */
import * as z from 'zod/mini';
import type { IsoDate } from '../../../domain/calendar';
import {
	MAX_PROPOSAL_OPS,
	programOpSchema,
	type ProgramOpKind
} from '../../../domain/coach/proposals';
import { decisionPlanSchema } from '../../../domain/training/schemas';
import type { Decider } from '../../../domain/training/vocabulary';
import {
	parseWith,
	TrainingInputError,
	TrainingNotFoundError,
	type TrainingDeps
} from '../training/shared';
import {
	detailsApplier,
	moveApplier,
	runSegmentApplier,
	setApplier,
	skipApplier,
	swapApplier,
	settled,
	type EditApplier,
	type PlannedEdit
} from './edits';
import {
	reviseProgram,
	type CopyChanges,
	type RevisedVersion,
	type RevisionDecision
} from './revise';

/** What an op is refused with when an earlier op of the batch already changes the same thing. */
export const OPS_OVERLAP = 'Another change in this proposal already changes this';

/** Each op's applier; a never-again swap's dislike is the coach's. */
const APPLIERS = {
	move: moveApplier,
	skip: skipApplier,
	swap: (ownerId, input, at, deps) =>
		swapApplier(ownerId, input, at, deps, { preferenceSource: 'coach' }),
	adjust_set: setApplier,
	adjust_run_segment: runSegmentApplier,
	adjust_details: detailsApplier
} satisfies Record<ProgramOpKind, EditApplier>;

/** Not-found errors about the program itself, not an op: they stay not found. */
const PROGRAM_LEVEL = new Set(['program', 'program version']);

export interface ProgramEditBatch {
	/** The version the ops were drafted on: it must still be the current one. */
	baseVersion: number;
	/** The owner's local today: nothing before it can be edited. */
	today: IsoDate;
	/** programOpSchema ops, 1 to MAX_PROPOSAL_OPS. */
	ops: readonly unknown[];
	/** The new version's summary in History: the proposal's title. */
	title: string;
	/** Every decision's 'why'. */
	rationale: string;
	/** Added to every decision's evidence, such as the proposal's id. */
	evidence?: Record<string, number | string | boolean>;
	/**
	 * Who decided: the coach (the default), whose decisions all take `rationale` as their why; or
	 * a review's rules or the owner, whose decisions keep each edit's own why, with its op's reason.
	 */
	decidedBy?: Decider;
	/** One more decision after the ops' own, such as a review's review_applied. */
	decision?: RevisionDecision;
}

const batchSchema = z.object({
	title: decisionPlanSchema.shape.summary,
	rationale: decisionPlanSchema.shape.why,
	ops: z
		.array(z.unknown(), 'List the changes')
		.check(
			z.minLength(1, 'Propose at least one change'),
			z.maxLength(MAX_PROPOSAL_OPS, `Up to ${MAX_PROPOSAL_OPS} changes`)
		)
});

/** Run op `n`'s step, its refusals keyed under `ops.n`. */
async function atOp<T>(n: number, step: () => Promise<T>): Promise<T> {
	try {
		return await step();
	} catch (err) {
		const at = (key: string) => (key ? `ops.${n}.${key}` : `ops.${n}`);
		if (err instanceof TrainingInputError) {
			throw new TrainingInputError(
				Object.fromEntries(Object.entries(err.errors).map(([key, message]) => [at(key), message]))
			);
		}
		if (err instanceof TrainingNotFoundError && !PROGRAM_LEVEL.has(err.what)) {
			throw new TrainingInputError({ [at('')]: `This ${err.what} is not in the program` });
		}
		throw err;
	}
}

type Fields = Record<string, unknown>;

/** Add `change` to row `key`; false when it sets a field the row already sets otherwise. */
function mergeRow(rows: Record<string, Fields>, key: string, change: Fields): boolean {
	const row = (rows[key] ??= {});
	for (const [field, value] of Object.entries(change)) {
		if (field in row && JSON.stringify(row[field]) !== JSON.stringify(value)) return false;
		row[field] = value;
	}
	return true;
}

/** Add `add` to `into`, row by row and field by field; false on an overlap. */
function merge(into: CopyChanges, add: CopyChanges): boolean {
	for (const table of ['sessions', 'details', 'exercises'] as const) {
		const rows = (into[table] ??= {}) as Record<string, Fields>;
		for (const [lineage, change] of Object.entries(add[table] ?? {})) {
			if (!mergeRow(rows, lineage, change)) return false;
		}
	}
	for (const table of ['segments', 'sets'] as const) {
		const rows = (into[table] ??= {}) as Record<string, Record<string, Fields>>;
		const added = (add[table] ?? {}) as Record<string, Record<string, Fields>>;
		for (const [lineage, positions] of Object.entries(added)) {
			for (const [n, change] of Object.entries(positions)) {
				if (!mergeRow((rows[lineage] ??= {}), n, change)) return false;
			}
		}
	}
	return true;
}

/**
 * Apply the coach's `batch.ops` to the owner's active program as one new version on
 * `batch.baseVersion`, with a coach decision per op. A TrainingInputError at `ops.n` for an op
 * that is invalid or refused, a ProgramConflictError for a stale base; nothing is written unless
 * all of it is.
 */
export async function applyProgramEdits(
	ownerId: string,
	batch: ProgramEditBatch,
	deps: TrainingDeps = {}
): Promise<RevisedVersion> {
	const { title, rationale, ops } = parseWith(batchSchema, batch);
	const decidedBy = batch.decidedBy ?? 'coach';
	const coach: TrainingDeps = { ...deps, source: decidedBy };
	const at = { version: batch.baseVersion, today: batch.today };

	const edits: PlannedEdit[] = [];
	let changes: CopyChanges = {};
	const movedTo = new Set<string>();
	for (const [n, raw] of ops.entries()) {
		// One op at a time: each applier reads through the same handle.
		const edit = await atOp(n, async () => {
			const { op, ...input } = parseWith(programOpSchema, raw);
			const planned = await APPLIERS[op](ownerId, input, at, coach);
			const day = op === 'move' ? (input as { toDate: IsoDate }).toDate : null;
			if ((day && movedTo.has(day)) || !merge(changes, planned.changes)) {
				throw new TrainingInputError({ '': OPS_OVERLAP });
			}
			if (day) movedTo.add(day);
			changes = settled(changes, planned);
			return planned;
		});
		edits.push(edit);
	}

	const [first, ...more] = [
		...edits.map(({ decision }): RevisionDecision => ({
			...decision,
			why: decidedBy === 'coach' ? rationale : decision.why,
			decidedBy,
			evidence: { ...decision.evidence, ...batch.evidence }
		})),
		...(batch.decision
			? [
					{
						...batch.decision,
						decidedBy,
						evidence: { ...batch.decision.evidence, ...batch.evidence }
					}
				]
			: [])
	];
	return reviseProgram(
		ownerId,
		{
			baseVersionNumber: batch.baseVersion,
			weekLineages: edits.flatMap((e) => e.weekLineages),
			apply: async (_copies, tx) => {
				for (const edit of edits) await edit.write?.(tx);
				return changes;
			},
			summary: title,
			decision: first!,
			moreDecisions: more
		},
		coach
	);
}
