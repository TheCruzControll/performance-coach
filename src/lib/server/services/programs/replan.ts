/**
 * Storing a re-plan (M7, PRD §5; ADR 0010 and docs/adr/NNNN-replans-as-versions.md): each
 * mechanism of periodisation/replan.ts as one new version, copy-on-write, with every guarantee
 * M3's edits and M6's next block give. Imported by path.
 *
 * storeReplan (regenerate and splice) writes version N + 1 in one transaction under the head's
 * lock:
 * - a stale base is a ProgramConflictError, before anything is written
 * - `from` is a Monday on or after today's and the program's start, with no session from it
 *   skipped or logged (REPLAN_START), and no new session is dated before it
 * - the whole version is rebuilt and parsed with programPlanSchema: every block ending before
 *   `from` (shared rows), a block running across it cut on the Sunday before (cutBlock: a new
 *   row, the same lineage, its weeks copied with theirs), the new blocks and outline (new rows,
 *   new lineages), and after a taper every block after it (shared; one running across the
 *   taper's end comes back from the Monday after, under a new lineage). A block starting on or
 *   after `from` is left out, never cut to zero weeks; from the program's start nothing is kept.
 * - the version stores REPLAN_GENERATOR_ID with the fingerprint, catalogue digest and input that
 *   built the new blocks, so services/analytics/targets.ts judges them by it; a cut block keeps
 *   its lineage, so it is still judged by the input that first planned it
 * - the decisions, a replanned one first, name the new version's plan paths and are stored as
 *   the lineages of the rows they name.
 * The in_place mechanism (a deload, M7's reviseDeload through M3's reviseProgram) is refused here
 * with REFUSALS.not_applicable until its store lands (m7r/29): the mechanism is kept in the type
 * and the dispatch, so that store can take its place.
 * Version N, its weeks and every workout logged against them are never touched.
 */
import * as z from 'zod/mini';
import { addDays, mondayOf, type IsoDate } from '../../../domain/calendar';
import {
	REFUSALS,
	REPLAN_GENERATOR_ID,
	type ReplanMechanism
} from '../../../domain/programming/rules/replan';
import { decisionPlanSchema, programPlanSchema } from '../../../domain/training/schemas';
import type { BlockPlan, DecisionPlan } from '../../../domain/training/types';
import type { Decider } from '../../../domain/training/vocabulary';
import type { FieldErrors } from '../../../domain/validation';
import { createPeriodiseRepository } from '../../db/repositories/program-periodise';
import { createReplanRepository } from '../../db/repositories/program-replan';
import { createProgramsRepository } from '../../db/repositories/programs';
import { measure } from '../../observability/timing';
import {
	parseWith,
	ProgramConflictError,
	resolveDeps,
	TrainingInputError,
	TrainingNotFoundError,
	type TrainingDeps
} from '../training/shared';
import { planRows, toProgramVersion, type StoredBlock } from './mapping';
import type { RevisedVersion } from './revise';
import { MAX_VERSION, resolveExercises, type ProgramOrigin } from './store';

export interface ReplanStorage {
	/** A regenerate (priorities, block), a taper's splice, or in_place (a deload: refused here). */
	mechanism: ReplanMechanism;
	/** The version re-planned: it must still be current. */
	baseVersionNumber: number;
	/** The owner's local today. */
	today: IsoDate;
	/** The first day the version differs on: a Monday (a splice's is its taper's first Monday). */
	from: IsoDate;
	/** The new planned blocks, from `from` on. */
	blocks: BlockPlan[];
	/** The outline after them (a regenerate's); a splice keeps the stored blocks instead. */
	outline: BlockPlan[];
	/** generateReplan's decisions, replanned first, their refs in the new version's numbering. */
	decisions: DecisionPlan[];
	/** The version's summary in History. */
	summary: string;
	createdBy: Decider;
	/** What built the new blocks; the generator is always REPLAN_GENERATOR_ID. */
	origin: Omit<ProgramOrigin, 'source' | 'generator'>;
}

const monday = z.iso
	.date('Use a real date')
	.check(z.refine((d) => mondayOf(d) === d, 'Start on a Monday'));

const storageSchema = z.object({
	mechanism: z.enum(['regenerate', 'splice', 'in_place'], 'Pick a mechanism'),
	today: z.iso.date('Use a real date'),
	from: monday,
	summary: decisionPlanSchema.shape.summary
});

const isVersionNumber = (n: unknown): n is number =>
	Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MAX_VERSION;

const fail = (errors: FieldErrors) => {
	if (Object.keys(errors).length) throw new TrainingInputError(errors);
};

/** A stored block the new version keeps: shared as it is, or cut into a new row. */
interface Kept {
	block: StoredBlock;
	/** Shared row for row; otherwise re-inserted with `block`'s dates under `lineage`. */
	shared: boolean;
	lineage: string;
	/** The stored row it is shared or cut from. */
	fromId: string;
}

const shared = (block: StoredBlock): Kept => ({
	block,
	shared: true,
	lineage: block.lineage,
	fromId: block.id
});

/** `block` re-dated to `startsOn`–`endsOn`, holding only its weeks inside them. */
const cut = (block: StoredBlock, startsOn: IsoDate, endsOn: IsoDate, lineage = block.lineage) => ({
	block: {
		...block,
		startsOn,
		endsOn,
		weeks: block.weeks.filter((w) => w.startsOn >= startsOn && w.endsOn <= endsOn)
	},
	shared: false,
	lineage,
	fromId: block.id
});

/** The lineage of the node `rest` (`.weeks.0.sessions.1`…) names under a kept block. */
function keptLineage(kept: Kept, rest: string): string {
	let node: { lineage: string } & Record<string, unknown> = {
		...kept.block,
		lineage: kept.lineage
	};
	for (const [, key, at] of rest.matchAll(/\.(weeks|sessions|exercises)\.(\d+)/g)) {
		node = (node[key!] as (typeof node)[])[Number(at)]!;
	}
	return node.lineage;
}

/** Every new session dated before `from`, by its path among the new blocks. */
function beforeFrom(blocks: BlockPlan[], from: IsoDate): FieldErrors {
	const errors: FieldErrors = {};
	blocks.forEach((block, b) =>
		block.weeks.forEach((week, w) =>
			week.sessions.forEach((s, i) => {
				if (s.date < from)
					errors[`blocks.${b}.weeks.${w}.sessions.${i}.date`] =
						`${s.title} on ${s.date} falls before the re-plan starts, ${from}`;
			})
		)
	);
	return errors;
}

/**
 * Store a re-plan as the owner's active program's next version, all of it checked first.
 * ProgramConflictError for a stale base; TrainingNotFoundError for no active program;
 * TrainingInputError for a start or a version that would not hold.
 */
export async function storeReplan(
	ownerId: string,
	storage: ReplanStorage,
	deps: Omit<TrainingDeps, 'source'> = {}
): Promise<RevisedVersion> {
	const { mechanism, today, from, summary } = parseWith(storageSchema, storage);
	const { baseVersionNumber: number, origin } = storage;
	if (!isVersionNumber(number)) throw new TrainingNotFoundError('program version');
	const added = [...storage.blocks, ...storage.outline];
	fail({
		// The deload store (in_place) is not built yet: refused before anything is read or written.
		...(mechanism === 'in_place' && { mechanism: REFUSALS.not_applicable }),
		// The week in progress is never rewritten: the first Monday from today (the plan's decision).
		...(from < today && { from: `Start on ${mondayOf(addDays(today, 6))} or later` }),
		...(!added.length && { blocks: 'Plan a block' }),
		...(mechanism === 'splice' && storage.outline.length && { outline: 'A taper keeps the rest' }),
		...(storage.decisions[0]?.kind !== 'replanned' && {
			'decisions.0.kind': 'Start with the replanned decision'
		}),
		...beforeFrom(storage.blocks, from)
	});
	const { db, now } = resolveDeps(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createProgramsRepository(tx);
			const periodise = createPeriodiseRepository(tx);
			const head = await repo.lockProgram(ownerId);
			if (!head) throw new TrainingNotFoundError('program');
			const base = await repo.findVersion(ownerId, head.id, number);
			if (!base || base.version.id !== head.currentVersionId) throw new ProgramConflictError();
			const { startsOn, firstPlannedDay } = base.version;
			if (from < startsOn) fail({ from: `Start on ${startsOn} or later` });
			const touched = await periodise.touchedFrom(ownerId, base.version.id, from);
			if (touched) {
				fail({ from: `${touched.title} on ${touched.date} is logged or skipped: start after it` });
			}

			// The whole version: what it keeps before `from`, the new blocks, and after a taper the rest.
			const tree = await repo.versionTree(base.version.id);
			const stored = toProgramVersion(base, tree, []).blocks;
			const before = stored.flatMap((b): Kept[] =>
				b.endsOn < from
					? [shared(b)]
					: b.startsOn < from
						? [cut(b, b.startsOn, addDays(from, -1))]
						: []
			);
			const end = added.at(-1)!.endsOn;
			const after =
				mechanism === 'regenerate'
					? []
					: stored.flatMap((b): Kept[] =>
							b.startsOn > end
								? [shared(b)]
								: b.endsOn > end
									? [cut(b, addDays(end, 1), b.endsOn, crypto.randomUUID())]
									: []
						);
			const whole = parseWith(programPlanSchema, {
				title: base.program.title,
				startsOn,
				firstPlannedDay,
				blocks: [...before.map((k) => k.block), ...added, ...after.map((k) => k.block)],
				decisions: storage.decisions
			});

			// The new blocks' rows, as M3's store maps a plan; their refs moved to the new blocks.
			const [k, n] = [before.length, added.length];
			const refs = whole.decisions.map((d) =>
				d.refs.map((ref) => {
					const [, at, rest] = /^blocks\.(\d+)(.*)$/.exec(ref)!;
					return { at: Number(at), rest: rest! };
				})
			);
			const fresh = {
				...whole,
				blocks: whole.blocks.slice(k, k + n),
				decisions: whole.decisions.map((d, x) => ({
					...d,
					refs: refs[x]!.filter((r) => r.at >= k && r.at < k + n).map(
						(r) => `blocks.${r.at - k}${r.rest}`
					)
				}))
			};
			const exerciseId = await resolveExercises(ownerId, fresh, { db: tx });
			const createdAt = now();
			const rows = planRows(fresh, {
				ownerId,
				at: createdAt,
				version: { createdBy: storage.createdBy, summary },
				exerciseId
			});
			const versionId = crypto.randomUUID();
			const kept = [...before, ...after];

			await createReplanRepository(tx).insertVersionSharing(
				{
					id: versionId,
					programId: head.id,
					number: number + 1,
					parentVersionId: base.version.id,
					createdBy: storage.createdBy,
					summary,
					generator: REPLAN_GENERATOR_ID,
					inputFingerprint: origin.fingerprint ?? null,
					catalogueDigest: origin.digest ?? null,
					inputSnapshot: origin.snapshot ?? null,
					startsOn,
					firstPlannedDay,
					createdAt
				},
				kept.filter((x) => x.shared).map((x) => x.fromId)
			);
			let position = Math.max(0, ...tree.blocks.map((b) => b.position));
			for (const { block, shared: same, lineage, fromId } of kept) {
				if (same) continue;
				const id = crypto.randomUUID();
				const dates = { startsOn: block.startsOn, endsOn: block.endsOn };
				await periodise.cutBlock(versionId, {
					fromId,
					id,
					lineageId: lineage,
					position: ++position,
					...dates
				});
				if (!block.weeks.length) continue;
				const subtree = await repo.weekSubtree(block.weeks.map((w) => w.id));
				const copies = (list: { id: string }[]) =>
					new Map(list.map((row) => [row.id, crypto.randomUUID()]));
				await repo.copyWeekSubtree(
					{
						versionId,
						weeks: copies(block.weeks),
						sessions: copies(subtree.sessions),
						exercises: copies(subtree.exercises),
						blocks: new Map([[fromId, id]])
					},
					{
						sessions: new Map(),
						exercises: new Map(),
						details: new Map(),
						segments: new Map(),
						sets: new Map()
					}
				);
			}
			const { program: _p, version: _v, ...tables } = rows.tree;
			await createReplanRepository(tx).insertPlannedBlocks({
				...tables,
				blocks: tables.blocks.map((row) => ({ ...row, programId: head.id, position: ++position })),
				versionBlocks: tables.versionBlocks.map((row) => ({ ...row, versionId })),
				versionWeeks: tables.versionWeeks.map((row) => ({ ...row, versionId }))
			});
			await repo.insertDecisions(
				rows.decisions.map((d, x) => {
					const made = [...d.affected!];
					const affected = refs[x]!.map((r) =>
						r.at < k
							? keptLineage(before[r.at]!, r.rest)
							: r.at >= k + n
								? keptLineage(after[r.at - k - n]!, r.rest)
								: made.shift()!
					);
					return { ...d, programId: head.id, versionId, affected };
				})
			);
			if (!(await repo.setCurrentVersion(head.id, base.version.id, versionId))) {
				throw new ProgramConflictError();
			}
			return { programId: head.id, versionId, number: number + 1 };
		})
	);
}
