/**
 * A workout's stored rows as the device reads them (wire format v1's CanonicalWorkout): keyed by
 * client ids, never by server ids, with every section, tombstones included, and the exercises its
 * rows name. The sync results carry it, and GET /api/workouts/[id] (canonical-reads) answers it.
 */
import type { CanonicalWorkout, ExerciseSummary, Instant } from '../../../domain/workout/index';
import type { CanonicalRows } from '../../db/repositories/workout-sync';
import type { ExerciseDef } from '../exercises/index';

const instant = (at: Date): Instant => at.toISOString();
const maybe = (at: Date | null): Instant | null => at && instant(at);

/** Every exercise a workout's rows name, so a device with no kit can still render them. */
export function exerciseIdsOf(rows: CanonicalRows): string[] {
	return [
		...new Set([
			...rows.sets.map((s) => s.exerciseId),
			...rows.substitutions.flatMap((s) => [s.fromExerciseId, s.toExerciseId]),
			...rows.pain.flatMap((p) => (p.exerciseId ? [p.exerciseId] : []))
		])
	];
}

const summaryOf = ({ name, measure, loadType, unilateral }: ExerciseDef): ExerciseSummary => ({
	name,
	measure,
	loadType,
	unilateral
});

export function toCanonicalWorkout(
	rows: CanonicalRows,
	exercises: ReadonlyMap<string, ExerciseDef>
): CanonicalWorkout {
	const { workout, sets, substitutions, pain, run, segments, other } = rows;
	return {
		v: 1,
		workout: {
			id: workout.clientId,
			kind: workout.kind,
			title: workout.title,
			sessionType: workout.sessionType,
			discipline: workout.discipline,
			plannedSessionId: workout.plannedSessionId,
			plannedLineage: workout.plannedLineageId,
			programId: workout.programId,
			status: workout.status,
			startedAt: instant(workout.startedAt),
			finishedAt: maybe(workout.finishedAt),
			notes: workout.notes,
			sessionRpe: workout.sessionRpe,
			durationSeconds: workout.durationSeconds,
			deletedAt: maybe(workout.deletedAt)
		},
		sets: sets.map((s) => ({
			id: s.clientMutationId,
			position: s.exercisePosition,
			plannedLineage: s.plannedExerciseLineageId,
			setIndex: s.setIndex,
			exerciseId: s.exerciseId,
			reps: s.reps,
			seconds: s.seconds,
			metres: s.metres,
			weight: s.weight,
			assistance: s.assistance,
			unit: s.unit,
			rpe: s.rpe,
			missedReps: s.missedReps,
			isWarmup: s.isWarmup,
			isExtra: s.isExtra,
			isSkipped: s.isSkipped,
			e1rmKg: s.e1rmKg,
			performedAt: instant(s.performedAt),
			deletedAt: maybe(s.deletedAt)
		})),
		substitutions: substitutions.map((s) => ({
			id: s.clientMutationId,
			// A device always names the slot; a row written without one (M3's own callers) reads
			// at position 0, which no slot has.
			position: s.exercisePosition ?? 0,
			plannedLineage: s.plannedExerciseLineageId,
			fromExerciseId: s.fromExerciseId,
			toExerciseId: s.toExerciseId,
			reason: s.reason,
			deletedAt: maybe(s.deletedAt)
		})),
		pain: pain.map((p) => ({
			id: p.id,
			position: p.exercisePosition,
			plannedLineage: p.plannedExerciseLineageId,
			// pain.report always names its exercise; '' only for a row written without one.
			exerciseId: p.exerciseId ?? '',
			area: p.bodyArea,
			severity: p.severity,
			action: p.action,
			substitutionId: p.substitutionClientId,
			note: p.note,
			reportedAt: instant(p.reportedAt),
			deletedAt: maybe(p.deletedAt)
		})),
		run: run && {
			distanceMetres: run.distanceMetres,
			durationSeconds: run.durationSeconds,
			avgHr: run.avgHr,
			rpe: run.rpe,
			notes: run.notes,
			paceSecondsPerKm: run.paceSecondsPerKm,
			segments: segments.map((s) => ({
				id: s.clientMutationId,
				position: s.position,
				kind: s.kind,
				distanceMetres: s.distanceMetres,
				durationSeconds: s.durationSeconds,
				avgHr: s.avgHr,
				rpe: s.rpe,
				paceSecondsPerKm: s.paceSecondsPerKm
			}))
		},
		other: other && {
			kind: other.kind,
			durationMinutes: other.durationMinutes,
			rpe: other.rpe,
			metrics: other.metrics,
			notes: other.notes
		},
		exercises: Object.fromEntries(
			exerciseIdsOf(rows).flatMap((id) => {
				const exercise = exercises.get(id);
				return exercise ? [[id, summaryOf(exercise)]] : [];
			})
		)
	};
}
