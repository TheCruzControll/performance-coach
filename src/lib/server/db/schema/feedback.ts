/**
 * What the owner reports about a workout as it happens (M4; PRD §7 'This hurts'). A pain report
 * is never an exercise preference: it records where it hurt, how badly and what the owner chose,
 * for the coach (M5) to read, and changes no program.
 *
 * - The row's id is the device's client id for it (the pain.report mutation's entity id), so a
 *   replayed report is a primary-key conflict the handler turns into a no-op.
 * - owner_id is ownerRef and workout_id names its workout, so the test cleanup (withCommitted)
 *   and the e2e reset (resetPrograms, from workouts) clear it.
 * - Its slot is the strength slot's 1-based position and planned lineage, as its sets name them;
 *   exercise_id is the exercise performed there, kept (ON DELETE RESTRICT) while a report names
 *   it, and null when the report names none.
 * - Area and severity may be left out, so both are nullable (an owner decision, open question
 *   'Pain flow' of the M4 plan; requiring them later is a migration adding NOT NULL once every
 *   stored report has them). body_area is open, as M2's injuries keep it; severity is CHECKed in
 *   M2's SEVERITIES and action in the contract's PAIN_ACTIONS.
 * - substitution_client_id is the client id of the exercise.substitute that a 'substituted'
 *   report sent beside it. It is not a foreign key: the two mutations sync independently.
 * - Rows take M3's logged-table guards (drizzle/<n>_pain_reports_guards.sql): an UPDATE that
 *   changes the row stamps updated_at and writes training_audit, one that changes nothing leaves
 *   no trace, and DELETE is refused; a report is deleted softly (deleted_at). Only test and reset
 *   code bypasses this (ADR 0010).
 */
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { SEVERITIES, type BodyArea, type Severity } from '../../../domain/profile/catalog';
import { PAIN_ACTIONS, type PainAction } from '../../../domain/workout/mutations';
import { createdAt, inList, ownerRef, updatedAt } from './columns';
import { exercises } from './exercises';
import { workouts } from './training-log';

/** A pain note's longest, in characters, as the log's other free-text notes are bounded. */
export const PAIN_NOTE_MAX = 500;

const SUBSTITUTED = 'substituted' satisfies PainAction;

export const painReports = pgTable(
	'pain_reports',
	{
		/** The device's client id for the report. */
		id: uuid('id').primaryKey(),
		ownerId: ownerRef(),
		workoutId: uuid('workout_id')
			.notNull()
			.references(() => workouts.id),
		/** The exercise performed in the slot; null when the report names none. */
		exerciseId: uuid('exercise_id').references(() => exercises.id, { onDelete: 'restrict' }),
		/** The planned exercise of the slot (its lineage); null off plan or for an added exercise. */
		plannedExerciseLineageId: uuid('planned_exercise_lineage_id'),
		/** The exercise's 1-based place in the workout, as its sets' exercise_position. */
		exercisePosition: integer('exercise_position').notNull(),
		/** One of M2's BODY_AREAS; open, as the injuries table keeps it. Null when left out. */
		bodyArea: text('body_area').$type<BodyArea>(),
		severity: text('severity').$type<Severity>(),
		action: text('action').$type<PainAction>().notNull(),
		substitutionClientId: uuid('substitution_client_id'),
		note: text('note'),
		/** When it happened on the device. */
		reportedAt: timestamp('reported_at', { withTimezone: true }).notNull(),
		createdAt: createdAt(),
		updatedAt: updatedAt(),
		deletedAt: timestamp('deleted_at', { withTimezone: true })
	},
	(t) => [
		// The owner's reports, newest first (the coach's pain memory).
		index('pain_reports_owner_reported_idx').on(t.ownerId, t.reportedAt.desc().nullsFirst()),
		// A workout's reports, deleted ones included (the canonical workout keeps their tombstones).
		index('pain_reports_workout_idx').on(t.workoutId),
		check('pain_reports_exercise_position_ck', sql`${t.exercisePosition} >= 1`),
		check('pain_reports_severity_ck', inList('severity', SEVERITIES)),
		check('pain_reports_action_ck', inList('action', PAIN_ACTIONS)),
		// Only a report that switched to a gentler option names a substitution.
		check(
			'pain_reports_substitution_ck',
			sql`${t.substitutionClientId} is null or ${t.action} = ${sql.raw(`'${SUBSTITUTED}'`)}`
		),
		check(
			'pain_reports_note_ck',
			sql`char_length(${t.note}) between 1 and ${sql.raw(String(PAIN_NOTE_MAX))}`
		)
	]
);
