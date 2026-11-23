/**
 * Program versioning (PRD §4–5, ADR 0010): the engine behind every edit, and the history it
 * leaves. reviseProgram writes version n + 1 by copy-on-write in one transaction:
 * - it locks the program head and compares: an edit made on a version that is no longer current
 *   is a ProgramConflictError, before the edit runs or anything is written
 * - the affected weeks' subtrees are copied (new ids, the same lineages) with the edit's changes
 *   written into the copies; history rows are never updated, so a copy is born edited
 * - every other block and week is shared through the membership rows
 * - one decision records what changed, why and who decided (or several, one per change, for an
 *   accepted coach proposal: ./batch.ts), and the head moves forward by compare-and-set.
 * The edits (m3/34, m3/39) and the coach's proposals (M5) all revise through it. History pages
 * newest first, HISTORY_PAGE_SIZE versions at a time, each with its decisions; any version stays
 * readable, a week at a time.
 */
import * as z from 'zod/mini';
import { decisionPlanSchema } from '../../../domain/training/schemas';
import type { DecisionView, VersionInfo } from '../../../domain/training/types';
import type { DecisionKind, Decider } from '../../../domain/training/vocabulary';
import {
	createProgramsRepository,
	type DecisionRow,
	type DetailChange,
	type ExerciseChange,
	type SegmentChange,
	type SessionChange,
	type SetChange,
	type WeekChange
} from '../../db/repositories/programs';
import type { Executor } from '../../db/types';
import { measure } from '../../observability/timing';
import {
	parseWith,
	ProgramConflictError,
	resolveDeps,
	TrainingInputError,
	TrainingNotFoundError,
	type TrainingDeps
} from '../training/shared';
import { getTrainingWeek, type TrainingWeek, type WeekAt } from './read';
import { MAX_VERSION } from './store';

/**
 * Decision (m3-plan: 'Version history is keyset-paginated, 20 per page'): how many versions one
 * History request reads. 'Show older versions' asks for the next page.
 */
export const HISTORY_PAGE_SIZE = 20;

/** A base row and its copy in the new version, by id. */
export interface Copy {
	from: string;
	to: string;
}

/** What a revision copies, each row by its lineage, as apply sees it. */
export interface WeekCopies {
	baseVersionId: string;
	/** The version being written. */
	versionId: string;
	weeks: Map<string, Copy>;
	/** Every session and planned exercise in those weeks. */
	sessions: Map<string, Copy>;
	exercises: Map<string, Copy>;
}

/**
 * How the copies differ from the base, by lineage: a session's columns and its details; a run
 * segment by its session's lineage and position; a planned exercise's columns; a set
 * prescription by its exercise's lineage and position. A revision changes values, never rows.
 * A week's kind and targets by its lineage (M7: a deload marks its week); left out, unchanged.
 */
export interface CopyChanges {
	weeks?: Record<string, WeekChange>;
	sessions?: Record<string, SessionChange>;
	details?: Record<string, DetailChange>;
	segments?: Record<string, Record<number, SegmentChange>>;
	exercises?: Record<string, ExerciseChange>;
	sets?: Record<string, Record<number, SetChange>>;
}

/** The decision a revision records: what, why (never empty) and who. */
export interface RevisionDecision {
	kind: DecisionKind;
	/** The rule or template that made it; null for an owner's own edit. */
	ruleKey?: string | null;
	/** What changed, in a sentence: the version's summary in History too. */
	summary: string;
	why: string;
	/** deps.source when left out. */
	decidedBy?: Decider;
	/** The lineages of the sessions and exercises it touched. */
	affected: string[];
	evidence?: Record<string, number | string | boolean>;
}

export interface Revision {
	/** The version the edit was made on: it must still be current. */
	baseVersionNumber: number;
	/** The weeks it changes, by lineage: each is copied whole, every other week is shared. */
	weekLineages: string[];
	/**
	 * Runs in the revising transaction before anything is written: reads what the edit needs
	 * through `tx` (it may write rows of its own outside the program, such as a preference) and
	 * returns how the copies differ.
	 */
	apply: (copies: WeekCopies, tx: Executor) => Promise<CopyChanges | void>;
	/** The edit's decision: its author is the version's, and so is its summary by default. */
	decision: RevisionDecision;
	/**
	 * The decisions after `decision`, in order, when the revision makes several changes: one per
	 * change of an accepted coach proposal (./batch.ts).
	 */
	moreDecisions?: RevisionDecision[];
	/** The version's summary in History; `decision`'s when left out. */
	summary?: string;
}

export interface RevisedVersion {
	programId: string;
	versionId: string;
	number: number;
}

export interface VersionHistoryEntry extends VersionInfo {
	decisions: DecisionView[];
}

export interface VersionHistory {
	/** Newest first. */
	versions: VersionHistoryEntry[];
	/** `before` for the next page; null once version 1 is listed. */
	nextCursor: number | null;
}

const decisionSchema = z.extend(
	z.pick(decisionPlanSchema, {
		kind: true,
		summary: true,
		why: true,
		decidedBy: true,
		evidence: true
	}),
	{
		ruleKey: z.nullable(decisionPlanSchema.shape.ruleKey),
		affected: z.array(z.uuid('Not a lineage')).check(z.maxLength(50))
	}
);

/** The most decisions one version records. */
const DECISIONS_MAX = 50;

const moreDecisionsSchema = z.object({
	moreDecisions: z
		.array(decisionSchema)
		.check(z.maxLength(DECISIONS_MAX - 1, `Up to ${DECISIONS_MAX} decisions`))
});

const summarySchema = z.pick(decisionPlanSchema, { summary: true });

const isVersionNumber = (n: unknown): n is number =>
	Number.isInteger(n) && (n as number) >= 1 && (n as number) <= MAX_VERSION;

/** Base row and copy by lineage, the copy with a fresh id. */
const copiesOf = (rows: { id: string; lineageId: string }[]) =>
	new Map(rows.map((row) => [row.lineageId, { from: row.id, to: crypto.randomUUID() }]));

/** Each copy's id by its base row's. */
const idsOf = (copies: Map<string, Copy>) =>
	new Map([...copies.values()].map(({ from, to }) => [from, to]));

/** CopyChanges by the base rows' ids; a lineage outside the copied weeks is a programming error. */
function changesByBaseId(copies: WeekCopies, changes: CopyChanges) {
	const base = (map: Map<string, Copy>, what: string) => (lineage: string) => {
		const copy = map.get(lineage);
		if (!copy) throw new Error(`the revision changes a ${what} outside the weeks it copies`);
		return copy.from;
	};
	const week = base(copies.weeks, 'week');
	const session = base(copies.sessions, 'session');
	const exercise = base(copies.exercises, 'planned exercise');
	const by = <T>(record: Record<string, T> = {}, id: (lineage: string) => string) =>
		new Map(Object.entries(record).map(([lineage, change]) => [id(lineage), change]));
	const at = <T>(record: Record<string, Record<number, T>> = {}, id: (lineage: string) => string) =>
		new Map(
			Object.entries(record).map(([lineage, positions]) => [
				id(lineage),
				new Map(Object.entries(positions).map(([n, change]) => [Number(n), change]))
			])
		);
	return {
		weeks: by(changes.weeks, week),
		sessions: by(changes.sessions, session),
		details: by(changes.details, session),
		segments: at(changes.segments, session),
		exercises: by(changes.exercises, exercise),
		sets: at(changes.sets, exercise)
	};
}

/**
 * Write the owner's active program's next version: `revision.weekLineages` copied with the
 * changes `apply` returns, the rest shared, and one decision. A ProgramConflictError when the
 * base is not the current version; TrainingNotFoundError for no active program or an unknown
 * week; nothing is written unless all of it is.
 */
export async function reviseProgram(
	ownerId: string,
	revision: Revision,
	deps: TrainingDeps = {}
): Promise<RevisedVersion> {
	const { db, now, source } = resolveDeps(deps);
	const defaults = (d: RevisionDecision) => ({
		ruleKey: null,
		evidence: {},
		decidedBy: source,
		...d
	});
	const decision = parseWith(decisionSchema, defaults(revision.decision));
	const { moreDecisions } = parseWith(moreDecisionsSchema, {
		moreDecisions: (revision.moreDecisions ?? []).map(defaults)
	});
	const decisions = [decision, ...moreDecisions];
	const { summary } = parseWith(summarySchema, {
		summary: revision.summary ?? decision.summary
	});
	const weekLineages = [...new Set(revision.weekLineages)];
	if (!weekLineages.length) {
		throw new TrainingInputError({ weekLineages: 'Name the weeks this edit changes' });
	}
	if (!isVersionNumber(revision.baseVersionNumber)) {
		throw new TrainingNotFoundError('program version');
	}
	return measure('db', () =>
		db.transaction(async (tx) => {
			const repo = createProgramsRepository(tx);
			const head = await repo.lockProgram(ownerId);
			if (!head) throw new TrainingNotFoundError('program');
			const base = await repo.findVersion(ownerId, head.id, revision.baseVersionNumber);
			if (!base || base.version.id !== head.currentVersionId) throw new ProgramConflictError();

			const weeks = new Map(
				(await repo.versionWeeks(base.version.id)).map((w) => [w.lineageId, w])
			);
			const affected = weekLineages.map((lineage) => {
				const week = weeks.get(lineage);
				if (!week) throw new TrainingNotFoundError('program week');
				return week;
			});
			const subtree = await repo.weekSubtree(affected.map((w) => w.id));
			const copies: WeekCopies = {
				baseVersionId: base.version.id,
				versionId: crypto.randomUUID(),
				weeks: copiesOf(affected),
				sessions: copiesOf(subtree.sessions),
				exercises: copiesOf(subtree.exercises)
			};
			const changes = changesByBaseId(copies, (await revision.apply(copies, tx)) ?? {});

			const { versionId } = copies;
			const number = base.version.number + 1;
			const at = now();
			// The generator's fields stay with the version a generator built.
			await repo.insertVersion(
				{
					id: versionId,
					programId: head.id,
					number,
					parentVersionId: base.version.id,
					createdBy: decision.decidedBy,
					summary,
					startsOn: base.version.startsOn,
					firstPlannedDay: base.version.firstPlannedDay,
					createdAt: at
				},
				affected.map((w) => w.id)
			);
			await repo.copyWeekSubtree(
				{
					versionId,
					weeks: idsOf(copies.weeks),
					sessions: idsOf(copies.sessions),
					exercises: idsOf(copies.exercises)
				},
				changes
			);
			await repo.insertDecisions(
				decisions.map((d) => ({ ...d, programId: head.id, versionId, createdAt: at }))
			);
			if (!(await repo.setCurrentVersion(head.id, base.version.id, versionId))) {
				throw new ProgramConflictError();
			}
			return { programId: head.id, versionId, number };
		})
	);
}

/**
 * The active program's versions, newest first, HISTORY_PAGE_SIZE at a time, from below version
 * `before` when given; null when there is no active program. Each version comes with its author,
 * summary and decisions, whose affected sessions and exercises are resolved to a title and a
 * date in that decision's version (blocks and weeks are left out).
 */
export async function getVersionHistory(
	ownerId: string,
	{ before }: { before?: number } = {},
	deps: TrainingDeps = {}
): Promise<VersionHistory | null> {
	if (before !== undefined && !isVersionNumber(before)) {
		throw new TrainingInputError({ before: 'A version number, from 1' });
	}
	const { db } = resolveDeps(deps);
	return measure('db', async () => {
		const repo = createProgramsRepository(db);
		const found = await repo.currentProgram(ownerId);
		if (!found) return null;
		const rows = await repo.versionHistory(found.program.id, {
			beforeNumber: before,
			limit: HISTORY_PAGE_SIZE
		});
		const versions = Map.groupBy(rows, (row) => row.version.id);
		const decisions = rows.flatMap(({ decision }) => (decision ? [decision] : []));
		const lineages = [...new Set(decisions.flatMap((d) => d.affected))];
		const nodes = await repo.affectedNodes([...versions.keys()], lineages);
		const named = new Map(
			nodes.map(({ versionId, ...node }) => [`${versionId}:${node.lineage}`, node])
		);
		const entries = [...versions.values()].map((group): VersionHistoryEntry => {
			const { version } = group[0]!;
			const view = (d: DecisionRow): DecisionView => ({
				id: String(d.id),
				version: version.number,
				createdAt: d.createdAt,
				kind: d.kind,
				ruleKey: d.ruleKey,
				summary: d.summary,
				why: d.why,
				decidedBy: d.decidedBy,
				affected: d.affected.flatMap((lineage) => named.get(`${version.id}:${lineage}`) ?? [])
			});
			return {
				number: version.number,
				createdAt: version.createdAt,
				createdBy: version.createdBy,
				summary: version.summary,
				current: version.id === found.program.currentVersionId,
				decisions: group.flatMap(({ decision }) => (decision ? [view(decision)] : []))
			};
		});
		// Numbers run 1, 2, 3… with no gaps (each revision is its base + 1, under the head's lock),
		// so older versions exist exactly while the oldest listed is not version 1.
		const oldest = entries.at(-1)?.number ?? 1;
		return { versions: entries, nextCursor: oldest > 1 ? oldest : null };
	});
}

/** A week of version `number` of the active program, by a date in it or by block and week. */
export async function getVersionWeek(
	ownerId: string,
	number: number,
	at: WeekAt,
	deps: TrainingDeps = {}
): Promise<TrainingWeek | null> {
	return getTrainingWeek(ownerId, at, { version: number }, deps);
}
