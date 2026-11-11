/**
 * Analytics persistence: runs queries/analytics.ts's fact queries one at a time and maps their
 * rows to the domain's facts (domain/analytics). Plain data access: the owner's calendar, the
 * windows and the memo belong to services/analytics/facts.ts.
 */
import type { IsoDate } from '../../../domain/calendar';
import type { PlannedSession } from '../../../domain/analytics/adherence';
import type { ActualSet, PlannedLines } from '../../../domain/analytics/prescribed';
import type { PlannedRun, RunFactSegment } from '../../../domain/analytics/running';
import type { StrengthFact } from '../../../domain/analytics/strength';
import type { LoggedSession, RecoveryEntry } from '../../../domain/analytics/workload';
import type { ExerciseMuscles } from '../../../domain/training/metrics';
import type { SetPrescription } from '../../../domain/training/types';
import {
	blockInputs,
	exerciseMuscles,
	firstActivity,
	plannedFacts,
	prescriptionFacts,
	programsInRange,
	recoveryFacts,
	segmentFacts,
	sessionFacts,
	setFacts,
	type SessionFactRow
} from '../queries/analytics';
import type { InstantRange } from '../queries/history';
import type { Executor } from '../types';

export type { ProgramInRangeRow } from '../queries/analytics';

/** A counted set: what the strength and prescription functions read, with its muscles. */
export type SetFact = StrengthFact &
	ActualSet &
	ExerciseMuscles & { exercisePosition: number; updatedAt: Date };

/** A recovery check-in, with when it last changed. */
export type RecoveryFact = RecoveryEntry & { updatedAt: Date };

/** A counted workout with its run or other-session record (null for the other kinds). */
export type SessionFact = SessionFactRow & LoggedSession;

/**
 * Planned sessions of every program in the range, the lineages a counted workout completed, and
 * the planned runs among them with their segments.
 */
export interface PlannedFacts {
	planned: PlannedSession[];
	completed: Set<string>;
	runs: PlannedRun[];
}

/** A program's generated versions' inputs, by the block lineages they first planned. */
export type BlockInputs = Map<string, Record<string, unknown>>;

export function createAnalyticsRepository(db: Executor) {
	/** Each exercise's muscles once read, shared by its sets (a few dozen exercises, 15k sets). */
	const muscles = new Map<string, ExerciseMuscles>();

	return {
		async sets(ownerId: string, range: InstantRange): Promise<SetFact[]> {
			const [row] = await setFacts(db, ownerId, range);
			const sets = row?.rows ?? [];
			const unknown = [...new Set(sets.map((set) => set.exercise))].filter(
				(id) => !muscles.has(id)
			);
			if (unknown.length > 0)
				for (const { id, ...worked } of await exerciseMuscles(db, unknown)) muscles.set(id, worked);
			// Each set gets its exercise's muscles in place: no copy of 15k sets.
			for (const set of sets as SetFact[]) {
				const worked = muscles.get(set.exercise)!;
				set.primaryMuscles = worked.primaryMuscles;
				set.secondaryMuscles = worked.secondaryMuscles;
			}
			return sets as SetFact[];
		},

		async sessions(ownerId: string, range: InstantRange): Promise<SessionFact[]> {
			const [row] = await sessionFacts(db, ownerId, range);
			return row?.rows ?? [];
		},

		/** Each run's segments in order, by workout id. */
		async segments(
			ownerId: string,
			workoutIds: readonly string[]
		): Promise<Map<string, RunFactSegment[]>> {
			if (!workoutIds.length) return new Map();
			const by = new Map<string, RunFactSegment[]>();
			const [row] = await segmentFacts(db, ownerId, workoutIds);
			for (const { workoutId, position: _p, ...segment } of row?.rows ?? []) {
				const held = by.get(workoutId);
				if (held) held.push(segment);
				else by.set(workoutId, [segment]);
			}
			return by;
		},

		/** Each planned session's exercises with their prescription lines, in order. */
		async prescriptions(
			plannedSessionIds: readonly string[]
		): Promise<Map<string, PlannedLines[]>> {
			if (!plannedSessionIds.length) return new Map();
			const q = prescriptionFacts(db, [...plannedSessionIds]);
			const [exercises] = await q.exercises;
			const [sets] = await q.sets;
			const lines = new Map<string, SetPrescription[]>();
			for (const { plannedExerciseId, line } of sets?.rows ?? []) {
				const held = lines.get(plannedExerciseId);
				if (held) held.push(line);
				else lines.set(plannedExerciseId, [line]);
			}
			const by = new Map<string, PlannedLines[]>();
			for (const row of exercises?.rows ?? []) {
				const planned = {
					lineage: row.lineageId,
					exerciseId: row.exerciseId,
					lines: lines.get(row.id) ?? []
				};
				const held = by.get(row.sessionId);
				if (held) held.push(planned);
				else by.set(row.sessionId, [planned]);
			}
			return by;
		},

		/**
		 * The programs in the range, then each one's sessions in it, then which were completed, then
		 * the planned runs' segments.
		 */
		async planned(ownerId: string, from: IsoDate, to: IsoDate): Promise<PlannedFacts> {
			const q = plannedFacts(db, ownerId);
			const planned: PlannedSession[] = [];
			const runs = new Map<string, Omit<PlannedRun, 'segments'>>();
			for (const program of await programsInRange(db, ownerId, from, to)) {
				for (const row of await q.planned(program.versionId, from, to)) {
					const { lineageId: lineage, scheduledOn: date, status, movedFrom, discipline } = row;
					planned.push({ lineage, date, status, movedFrom, discipline });
					if (discipline === 'running') runs.set(row.id, { lineage, date, status });
				}
			}
			const lineages = [...new Set(planned.map((s) => s.lineage))];
			const completed = lineages.length ? await q.completed(lineages) : [];
			const segments = runs.size ? await q.runSegments([...runs.keys()]) : [];
			const bySession = Map.groupBy(segments, (row) => row.sessionId);
			return {
				planned,
				completed: new Set(completed.map((row) => row.lineage!)),
				runs: [...runs].map(([id, run]) => ({
					...run,
					segments: (bySession.get(id) ?? []).map(
						({ id: _id, sessionId: _s, position: _p, ...segment }) => segment
					)
				}))
			};
		},

		async recovery(ownerId: string, from: IsoDate, to: IsoDate): Promise<RecoveryFact[]> {
			return recoveryFacts(db, ownerId, from, to);
		},

		async programsInRange(ownerId: string, from: IsoDate, to: IsoDate) {
			return programsInRange(db, ownerId, from, to);
		},

		/** The input that built each planned block lineage: the lowest generated version's. */
		async blockInputs(programId: string): Promise<BlockInputs> {
			const inputs: BlockInputs = new Map();
			for (const row of await blockInputs(db, programId)) {
				if (!inputs.has(row.blockLineage)) inputs.set(row.blockLineage, row.input!);
			}
			return inputs;
		},

		async firstActivity(ownerId: string): Promise<Date | null> {
			const [row] = await firstActivity(db, ownerId);
			return row?.at ?? null;
		}
	};
}

export type AnalyticsRepository = ReturnType<typeof createAnalyticsRepository>;
