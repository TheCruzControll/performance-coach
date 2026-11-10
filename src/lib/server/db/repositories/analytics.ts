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
export type SessionFact = Omit<SessionFactRow, 'run' | 'other'> &
	LoggedSession & {
		run: Omit<NonNullable<SessionFactRow['run']>, 'workoutId'> | null;
	};

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

/** A left join's record: null when the workout has none (its key is null). */
function toSession({ run, other, ...row }: SessionFactRow): SessionFact {
	const { workoutId, ...totals } = run ?? { workoutId: null };
	return {
		...row,
		run: workoutId ? totals : null,
		other: other?.kind ? other : null
	} as SessionFact;
}

export function createAnalyticsRepository(db: Executor) {
	return {
		async sets(ownerId: string, range: InstantRange): Promise<SetFact[]> {
			return setFacts(db, ownerId, range);
		},

		async sessions(ownerId: string, range: InstantRange): Promise<SessionFact[]> {
			return (await sessionFacts(db, ownerId, range)).map(toSession);
		},

		/** Each run's segments in order, by workout id. */
		async segments(
			ownerId: string,
			workoutIds: readonly string[]
		): Promise<Map<string, RunFactSegment[]>> {
			if (!workoutIds.length) return new Map();
			const by = new Map<string, RunFactSegment[]>();
			for (const { workoutId, position: _p, ...segment } of await segmentFacts(
				db,
				ownerId,
				workoutIds
			)) {
				by.set(workoutId, [...(by.get(workoutId) ?? []), segment]);
			}
			return by;
		},

		/** Each planned session's exercises with their prescription lines, in order. */
		async prescriptions(
			plannedSessionIds: readonly string[]
		): Promise<Map<string, PlannedLines[]>> {
			if (!plannedSessionIds.length) return new Map();
			const q = prescriptionFacts(db, [...plannedSessionIds]);
			const exercises = await q.exercises;
			const sets = Map.groupBy(await q.sets, (row) => row.plannedExerciseId);
			const by = new Map<string, PlannedLines[]>();
			for (const row of exercises) {
				const lines = (sets.get(row.id) ?? []).map(
					({ id: _id, plannedExerciseId: _e, position: _p, ...line }): SetPrescription => line
				);
				const planned = { lineage: row.lineageId, exerciseId: row.exerciseId, lines };
				by.set(row.sessionId, [...(by.get(row.sessionId) ?? []), planned]);
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
