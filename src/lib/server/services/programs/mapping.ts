/**
 * Between the program-plan contract (domain/training/types.ts) and the program tables: a plan
 * as the rows of a new program's version 1, and a stored version's rows as the plan tree again,
 * each node with its row id and lineage. Columns are named after the contract's fields, so a set
 * prescription, run segment or session detail row is its contract type plus its keys.
 */
import type { IsoDate } from '../../../domain/calendar';
import type {
	BlockPlan,
	DecisionPlan,
	ExerciseRef,
	OtherSessionPlan,
	PlannedExercisePlan,
	PlanPath,
	ProgramPlan,
	RunSessionPlan,
	SessionPlan,
	SessionSource,
	StrengthSessionPlan,
	WeekPlan,
	WeekTargets
} from '../../../domain/training/types';
import type { PlanStatus } from '../../../domain/training/vocabulary';
import type { ProgramStatus } from '../../db/schema/programs';
import type {
	DecisionRow,
	DecisionValues,
	ProgramTreeRows,
	VersionRow,
	VersionTreeRows
} from '../../db/repositories/programs';

// ---- the stored tree ------------------------------------------------------------------------

/** A stored node: its row id, and its lineage, which every copy in a later version keeps. */
interface Node {
	id: string;
	lineage: string;
}

export type StoredExercise = PlannedExercisePlan & Node;

export type StoredSession = (
	| (Omit<StrengthSessionPlan, 'exercises'> & { exercises: StoredExercise[] })
	| RunSessionPlan
	| OtherSessionPlan
) &
	Node & { status: PlanStatus; movedFrom: IsoDate | null };

/** A week's sessions read back by day, then by their order in the day. */
export type StoredWeek = Omit<WeekPlan, 'sessions'> & Node & { sessions: StoredSession[] };
export type StoredBlock = Omit<BlockPlan, 'weeks'> & Node & { weeks: StoredWeek[] };

/** A decision with what it touched as lineage ids (its plan paths, resolved at store time). */
export interface StoredDecision extends Omit<DecisionPlan, 'refs' | 'ruleKey'> {
	id: number;
	/** Null for an owner's edit that no rule made. */
	ruleKey: string | null;
	affected: string[];
	createdAt: Date;
}

/** A version's own fields, with whether it is the program's current one (false: an older one). */
export type VersionInfo = Omit<
	VersionRow['version'],
	'programId' | 'startsOn' | 'firstPlannedDay'
> & {
	current: boolean;
};

export interface ProgramVersion extends Pick<
	ProgramPlan,
	'title' | 'startsOn' | 'firstPlannedDay'
> {
	programId: string;
	status: ProgramStatus;
	version: VersionInfo;
	blocks: StoredBlock[];
	decisions: StoredDecision[];
}

// ---- plan → rows ----------------------------------------------------------------------------

export interface NewProgram {
	ownerId: string;
	at: Date;
	/** Who built version 1, and from what. */
	version: Pick<
		ProgramTreeRows['version'],
		'createdBy' | 'summary' | 'generator' | 'inputFingerprint' | 'catalogueDigest' | 'inputSnapshot'
	>;
	/** The library row an ExerciseRef resolved to. */
	exerciseId: (ref: ExerciseRef) => string;
}

/**
 * A validated plan as the rows of a new program and its version 1, with fresh ids and lineages,
 * and its decisions with their plan paths resolved to those lineages.
 */
export function planRows(plan: ProgramPlan, p: NewProgram) {
	const newId = () => crypto.randomUUID();
	const programId = newId();
	const versionId = newId();
	const lineages = new Map<PlanPath, string>();
	const tree: ProgramTreeRows = {
		program: { id: programId, ownerId: p.ownerId, title: plan.title, createdAt: p.at },
		version: {
			...p.version,
			id: versionId,
			programId,
			number: 1,
			startsOn: plan.startsOn,
			firstPlannedDay: plan.firstPlannedDay,
			createdAt: p.at
		},
		blocks: [],
		versionBlocks: [],
		weeks: [],
		versionWeeks: [],
		sessions: [],
		exercises: [],
		sets: [],
		segments: [],
		details: []
	};
	/** A new node's id, and its lineage recorded under its plan path. */
	const node = (path: PlanPath) => {
		const lineageId = newId();
		lineages.set(path, lineageId);
		return { id: newId(), lineageId };
	};

	plan.blocks.forEach(({ weeks, ...block }, b) => {
		const blockPath = `blocks.${b}`;
		const blockRow = { ...block, ...node(blockPath), programId, position: b + 1 };
		tree.blocks.push(blockRow);
		tree.versionBlocks.push({ versionId, blockId: blockRow.id });
		weeks.forEach(({ sessions, targets, ...week }, w) => {
			const weekPath = `${blockPath}.weeks.${w}`;
			const weekRow = {
				...week,
				...node(weekPath),
				blockId: blockRow.id,
				indexInBlock: w + 1,
				targets: { ...targets }
			};
			tree.weeks.push(weekRow);
			tree.versionWeeks.push({ versionId, weekId: weekRow.id });
			sessions.forEach((session, s) => {
				const sessionPath = `${weekPath}.sessions.${s}`;
				const sessionRow = { ...sessionColumns(session), ...node(sessionPath), weekId: weekRow.id };
				const sessionId = sessionRow.id;
				tree.sessions.push(sessionRow);
				if (session.kind === 'run') {
					session.segments.forEach((segment, k) =>
						tree.segments.push({ ...segment, id: newId(), sessionId, position: k + 1 })
					);
				} else if (session.kind === 'other') {
					tree.details.push({ ...session.details, sessionId });
				} else {
					session.exercises.forEach(({ exercise, substitutedFrom, sets, ...rest }, x) => {
						const exerciseRow = {
							...rest,
							...node(`${sessionPath}.exercises.${x}`),
							sessionId,
							position: x + 1,
							exerciseId: p.exerciseId(exercise),
							substitutedFromExerciseId: substitutedFrom && p.exerciseId(substitutedFrom)
						};
						tree.exercises.push(exerciseRow);
						sets.forEach((set, k) =>
							tree.sets.push({
								...set,
								id: newId(),
								plannedExerciseId: exerciseRow.id,
								position: k + 1
							})
						);
					});
				}
			});
		});
	});

	const decisions: DecisionValues[] = plan.decisions.map(({ refs, ...decision }) => ({
		...decision,
		programId,
		versionId,
		// programPlanSchema has checked that every path names a node.
		affected: refs.map((ref) => lineages.get(ref)!),
		createdAt: p.at
	}));
	return { tree, decisions };
}

/** A session's own columns, without its kind's children. */
function sessionColumns(s: SessionPlan) {
	return {
		scheduledOn: s.date,
		timeOfDay: s.timeOfDay,
		orderInDay: s.orderInDay,
		discipline: s.discipline,
		customDiscipline: s.customDiscipline,
		sessionType: s.type,
		title: s.title,
		estMinutes: s.estMinutes,
		estLoad: s.estLoad,
		intensity: s.intensity,
		targetRpe: s.targetRpe,
		status: 'planned' as const,
		source: s.source,
		commitmentRef: s.commitmentRef,
		instructions: s.instructions,
		notes: s.notes
	};
}

// ---- rows → the stored tree -----------------------------------------------------------------

/** An exercise row's reference: a catalogue row by key, or the owner's own by id. */
export const refOf = (id: string, key: string | null): ExerciseRef =>
	key ? { key } : { customId: id };

/** Session rows and their children, as versionTree or a program read returns them. */
export interface SessionRows extends Pick<
	VersionTreeRows,
	'sessions' | 'exercises' | 'segments' | 'details'
> {
	/** Left out by reads that show a session's line only: its exercises then have no sets. */
	sets?: VersionTreeRows['sets'];
}

/** Each session row as a stored session, by row id, in the rows' order. */
export function toStoredSessions(rows: SessionRows): Map<string, StoredSession> {
	const exercisesOf = Map.groupBy(rows.exercises, (row) => row.sessionId);
	const setsOf = Map.groupBy(rows.sets ?? [], (row) => row.plannedExerciseId);
	const segmentsOf = Map.groupBy(rows.segments, (row) => row.sessionId);
	const detailsOf = new Map(rows.details.map((row) => [row.sessionId, row]));

	const toExercise = (row: VersionTreeRows['exercises'][number]): StoredExercise => ({
		id: row.id,
		lineage: row.lineageId,
		exercise: refOf(row.exerciseId, row.exerciseKey),
		baselineLift: row.baselineLift,
		superset: row.superset,
		substitutedFrom:
			row.substitutedFromExerciseId === null
				? null
				: refOf(row.substitutedFromExerciseId, row.substitutedFromKey),
		substitutionReason: row.substitutionReason,
		instructions: row.instructions,
		notes: row.notes,
		sets: (setsOf.get(row.id) ?? []).map(
			({ id: _id, plannedExerciseId: _parent, position: _position, ...set }) => set
		)
	});

	const toSession = (row: VersionTreeRows['sessions'][number]): StoredSession => {
		const { id, weekId: _week, lineageId, scheduledOn, sessionType, ...columns } = row;
		const session = {
			...columns,
			id,
			lineage: lineageId,
			date: scheduledOn,
			type: sessionType,
			// The store always writes both.
			estLoad: columns.estLoad ?? 0,
			targetRpe: columns.targetRpe ?? 0,
			source: columns.source as SessionSource
		};
		// Each kind has at least one child row of its own (programPlanSchema), and only that kind.
		const exercises = exercisesOf.get(id);
		if (exercises) return { ...session, kind: 'strength', exercises: exercises.map(toExercise) };
		const segments = segmentsOf.get(id);
		if (segments) {
			return {
				...session,
				kind: 'run',
				segments: segments.map(({ id: _id, sessionId: _s, position: _p, ...segment }) => segment)
			};
		}
		const details = detailsOf.get(id);
		if (details) {
			const { sessionId: _s, ...other } = details;
			return { ...session, kind: 'other', details: other };
		}
		throw new Error(`planned session ${id} has no exercises, segments or details`);
	};

	return new Map(rows.sessions.map((row) => [row.id, toSession(row)]));
}

export function toProgramVersion(
	{ program, version }: VersionRow,
	rows: VersionTreeRows,
	decisions: DecisionRow[]
): ProgramVersion {
	const weeksOf = Map.groupBy(rows.weeks, (row) => row.blockId);
	const sessionsOf = Map.groupBy(rows.sessions, (row) => row.weekId);
	const sessions = toStoredSessions(rows);

	const { programId: _program, startsOn, firstPlannedDay, ...info } = version;
	return {
		programId: program.id,
		title: program.title,
		status: program.status,
		startsOn,
		firstPlannedDay,
		version: { ...info, current: program.currentVersionId === version.id },
		blocks: rows.blocks.map(({ id, lineageId, programId: _p, position: _n, ...block }) => ({
			...block,
			id,
			lineage: lineageId,
			progression: (block.progression ?? {}) as Record<string, number>,
			weeks: (weeksOf.get(id) ?? []).map(
				({ id: weekId, lineageId: lineage, blockId: _b, indexInBlock: _i, ...week }) => ({
					...week,
					id: weekId,
					lineage,
					targets: week.targets as unknown as WeekTargets,
					sessions: (sessionsOf.get(weekId) ?? []).map((row) => sessions.get(row.id)!)
				})
			)
		})),
		decisions: decisions.map(({ programId: _p, versionId: _v, evidence, ...decision }) => ({
			...decision,
			evidence: (evidence ?? {}) as StoredDecision['evidence']
		}))
	};
}
