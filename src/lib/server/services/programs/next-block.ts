/**
 * Planning a later block (PRD §11; ADR 0010 and the planning-later-blocks ADR): a generated next
 * block, and any bridge before it, stored as version N + 1, the way every edit is stored. planBlock
 * writes it in one transaction under the program head's lock:
 * - a base that is no longer current is a ProgramConflictError, before anything is written
 * - the whole new version is rebuilt as one ProgramPlan and parsed with programVersionSchema
 *   (programPlanSchema's rules without its 12-block cap, as planned blocks accumulate): the
 *   base's planned blocks with their weeks, the bridge, the new block and the outline after it.
 *   A gap, an overlap or an outline before a planned block is refused with checkPlan's message.
 * - no new-block session may fall before `firstPlannedDay`, the day the owner chose to start
 *   ('this week' from a Wednesday plans nothing on Monday or Tuesday). programVersionSchema checks
 *   only the version's own first day, which is week 1 of the program.
 * - the base's planned blocks and their weeks are shared; the outline block it plans and every
 *   outline block after it come back as new rows with their lineages: the planned block keeps the
 *   outline's, `shifted` carries the rest with their new dates (ShiftedBlock).
 * - the version stores the generator, fingerprint, catalogue digest and input that built the
 *   block, which services/analytics/targets.ts reads for that block's weeks
 * - decision refs name the new block as `blocks.0` (the generator's paths) and are stored as the
 *   new rows' lineages.
 * Version N, its weeks and every workout logged against them are never touched.
 */
import * as z from 'zod/mini';
import type { IsoDate } from '../../../domain/calendar';
import { decisionPlanSchema, programVersionSchema } from '../../../domain/training/schemas';
import type { BlockPlan, DecisionPlan, ProgramPlan } from '../../../domain/training/types';
import type { Decider } from '../../../domain/training/vocabulary';
import type { FieldErrors } from '../../../domain/validation';
import { createReplanRepository } from '../../db/repositories/program-replan';
import { createProgramsRepository } from '../../db/repositories/programs';
import { measure } from '../../observability/timing';
import { isUuid } from '../ids';
import {
	parseWith,
	ProgramConflictError,
	resolveDeps,
	TrainingInputError,
	TrainingNotFoundError,
	type TrainingDeps
} from '../training/shared';
import { planRows, toProgramVersion } from './mapping';
import type { RevisedVersion } from './revise';
import { MAX_VERSION, resolveExercises, type ProgramOrigin } from './store';

/** planBlock's `blockLineage` for a block added after the last one: no outline is left to plan. */
export const APPEND = 'append';

/**
 * An outline block of the base after the new block, by lineage, with its new dates. `shifted` is
 * the whole outline after the new block, as next-block/dates.ts lays it (planning-later-blocks
 * ADR): an outline block it leaves out (one an event build cut to no weeks) leaves the version,
 * and the rest of an outline block longer than one review plans is named by that block's lineage
 * and stored under a new one. A shifted block keeps its phase, name and goals but not its weeks,
 * which hold no sessions: the review that plans it lays them out.
 */
export interface ShiftedBlock {
	lineage: string;
	startsOn: IsoDate;
	endsOn: IsoDate;
}

export interface BlockPlanning {
	/** The version the block was generated from: it must still be current. */
	baseVersionNumber: number;
	/** The outline block this plans, by lineage, or APPEND. */
	blockLineage: string;
	/** The 'Between blocks' bridge of a late start: unplanned weeks, no sessions. */
	bridge?: BlockPlan;
	block: BlockPlan;
	shifted: ShiftedBlock[];
	/** The first day the new block may hold a session (next-block/dates.ts). */
	firstPlannedDay: IsoDate;
	/** The generator's decisions, their refs naming the new block as `blocks.0`. */
	decisions: DecisionPlan[];
	createdBy: Decider;
	/** The version's summary in History. */
	summary: string;
	/** What built the block: the version keeps it, so targets.ts judges the block by its input. */
	origin: Omit<ProgramOrigin, 'source'>;
}

const planningSchema = z.object({
	firstPlannedDay: z.iso.date('Use a real date'),
	summary: decisionPlanSchema.shape.summary,
	shifted: z
		.array(
			z.object({
				lineage: z.uuid('Not a lineage'),
				startsOn: z.iso.date('Use a real date'),
				endsOn: z.iso.date('Use a real date')
			})
		)
		.check(z.maxLength(12, 'Up to 12 blocks'))
});

const BLOCK_REF = /^blocks\.0(?=\.|$)/;

/** The decisions with their refs moved from `blocks.0` to block `index`; any other ref refused. */
function rebased(decisions: DecisionPlan[], index: number): DecisionPlan[] {
	const errors: FieldErrors = {};
	const moved = decisions.map((d, n) => ({
		...d,
		refs: d.refs.map((ref, r) => {
			if (!BLOCK_REF.test(ref)) errors[`decisions.${n}.refs.${r}`] = 'Name a part of the new block';
			return ref.replace(BLOCK_REF, `blocks.${index}`);
		})
	}));
	if (Object.keys(errors).length) throw new TrainingInputError(errors);
	return moved;
}

/** Every session of the new block dated before `firstPlannedDay`, by title and date. */
function beforeFirstDay(block: BlockPlan, firstPlannedDay: IsoDate): FieldErrors {
	const errors: FieldErrors = {};
	block.weeks.forEach((week, w) =>
		week.sessions.forEach((s, i) => {
			if (s.date < firstPlannedDay) {
				errors[`block.weeks.${w}.sessions.${i}.date`] =
					`${s.title} on ${s.date} falls before the first planned day, ${firstPlannedDay}`;
			}
		})
	);
	return errors;
}

/**
 * Store `planning`'s block, and its bridge, as the owner's active program's next version, every
 * part of it checked first. ProgramConflictError for a stale base; TrainingNotFoundError for no
 * active program or an unknown outline block; TrainingInputError for a version that would not hold.
 */
export async function planBlock(
	ownerId: string,
	planning: BlockPlanning,
	deps: Omit<TrainingDeps, 'source'> = {}
): Promise<RevisedVersion> {
	const { firstPlannedDay, summary, shifted } = parseWith(planningSchema, planning);
	const { baseVersionNumber: number, blockLineage, bridge, block } = planning;
	if (!Number.isInteger(number) || number < 1 || number > MAX_VERSION) {
		throw new TrainingNotFoundError('program version');
	}
	if (blockLineage !== APPEND && !isUuid(blockLineage)) {
		throw new TrainingNotFoundError('program block');
	}
	const { db, now } = resolveDeps(deps);
	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createProgramsRepository(tx);
			const head = await repo.lockProgram(ownerId);
			if (!head) throw new TrainingNotFoundError('program');
			const base = await repo.findVersion(ownerId, head.id, number);
			if (!base || base.version.id !== head.currentVersionId) throw new ProgramConflictError();

			const tree = await repo.versionTree(base.version.id);
			const stored = toProgramVersion(base, tree, []).blocks;
			const planned = stored.filter((b) => !b.outline);
			const outlineOf = new Map(stored.filter((b) => b.outline).map((b) => [b.lineage, b]));
			const replaced = blockLineage === APPEND ? null : outlineOf.get(blockLineage);
			if (replaced === undefined) throw new TrainingNotFoundError('program block');

			const errors: FieldErrors = {};
			const seen = new Set<string>();
			const outlines = shifted.flatMap((s, i): BlockPlan[] => {
				const from = outlineOf.get(s.lineage);
				if (!from || seen.has(s.lineage)) {
					errors[`shifted.${i}.lineage`] = from ? 'Named twice' : 'Not an outline block here';
					return [];
				}
				seen.add(s.lineage);
				return [{ ...from, startsOn: s.startsOn, endsOn: s.endsOn, weeks: [] }];
			});
			bridge?.weeks.forEach((week, w) => {
				if (week.sessions.length) errors[`bridge.weeks.${w}.sessions`] = 'A bridge has no sessions';
			});
			if (Object.keys(errors).length) throw new TrainingInputError(errors);

			// The whole version as one plan: the base's planned blocks, then everything new.
			const added = [...(bridge ? [bridge] : []), block, ...outlines];
			const at = bridge ? 1 : 0;
			const whole = parseWith(programVersionSchema, {
				title: base.program.title,
				startsOn: base.version.startsOn,
				firstPlannedDay: base.version.firstPlannedDay,
				blocks: [...planned, ...added],
				decisions: rebased(planning.decisions, planned.length + at)
			} satisfies ProgramPlan);
			const early = beforeFirstDay(whole.blocks[planned.length + at]!, firstPlannedDay);
			if (Object.keys(early).length) throw new TrainingInputError(early);

			// The new blocks' rows, as M3's store maps a plan, then joined to this program.
			const fresh: ProgramPlan = {
				...whole,
				blocks: whole.blocks.slice(planned.length),
				decisions: rebased(planning.decisions, at)
			};
			const exerciseId = await resolveExercises(ownerId, fresh, { db: tx });
			const createdAt = now();
			const rows = planRows(fresh, {
				ownerId,
				at: createdAt,
				version: { createdBy: planning.createdBy, summary },
				exerciseId
			});
			const versionId = crypto.randomUUID();
			const lineages = [
				...(bridge ? [null] : []),
				replaced?.lineage ?? null,
				...shifted.map((s) => (s.lineage === replaced?.lineage ? null : s.lineage))
			];
			const position = Math.max(0, ...tree.blocks.filter((b) => !b.outline).map((b) => b.position));
			const renamed = new Map<string, string>();
			const blocks = rows.tree.blocks.map((row, i) => {
				const lineageId = lineages[i] ?? row.lineageId!;
				renamed.set(row.lineageId!, lineageId);
				return { ...row, programId: head.id, position: position + 1 + i, lineageId };
			});
			const { program: _p, version: _v, ...tables } = rows.tree;

			const replan = createReplanRepository(tx);
			await replan.insertVersionSharing(
				{
					id: versionId,
					programId: head.id,
					number: number + 1,
					parentVersionId: base.version.id,
					createdBy: planning.createdBy,
					summary,
					generator: planning.origin.generator ?? null,
					inputFingerprint: planning.origin.fingerprint ?? null,
					catalogueDigest: planning.origin.digest ?? null,
					inputSnapshot: planning.origin.snapshot ?? null,
					startsOn: base.version.startsOn,
					firstPlannedDay: base.version.firstPlannedDay,
					createdAt
				},
				planned.map((b) => b.id)
			);
			await replan.insertPlannedBlocks({
				...tables,
				blocks,
				versionBlocks: tables.versionBlocks.map((row) => ({ ...row, versionId })),
				versionWeeks: tables.versionWeeks.map((row) => ({ ...row, versionId }))
			});
			await repo.insertDecisions(
				rows.decisions.map((d) => ({
					...d,
					programId: head.id,
					versionId,
					affected: d.affected!.map((lineage) => renamed.get(lineage) ?? lineage)
				}))
			);
			if (!(await repo.setCurrentVersion(head.id, base.version.id, versionId))) {
				throw new ProgramConflictError();
			}
			return { programId: head.id, versionId, number: number + 1 };
		})
	);
}
