/**
 * The sync ledger (ADR 0012, 'Exactly once'): every workout mutation id the server has applied,
 * written in the same transaction as the mutation's effect. A mutation that arrives again (a
 * retry after a timeout the server had already committed, a second tab, a replayed outbox) finds
 * its id here and is never applied twice. M3's replay contract alone leaves two gaps this closes:
 * finish, abandon and a dislike with its program swap create no unique row, and an old edit
 * replayed after a newer one from another device would overwrite it.
 *
 * - One row per applied mutation, keyed by the mutation's id. Rejected, deferred and retried
 *   mutations leave no row, so a corrected payload can be re-sent under the same id.
 * - owner_id is ownerRef, so the test cleanup (withCommitted) and the e2e reset clear it.
 * - type is open: the sync endpoint's schemas validate the contract's types and Postgres never
 *   CHECKs them, so later milestones add types without a migration.
 * - Rows never change and are never deleted (drizzle/<n>_sync_ledger_guards.sql reuses the
 *   history guards); only test and reset code bypasses them (ADR 0010).
 * - Retention (an owner decision, open question 17 of the M4 plan): rows are never pruned in M4,
 *   about 15k a year, so an outbox replayed months later is still recognised. Nothing reads or
 *   deletes by age; pruning, if the owner wants it, is a later migration that drops the delete
 *   guard for rows older than its window.
 */
import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { ownerRef } from './columns';

export const syncMutations = pgTable(
	'sync_mutations',
	{
		/** The mutation's id (its envelope's crypto.randomUUID): applied at most once. */
		mutationId: uuid('mutation_id').primaryKey(),
		ownerId: ownerRef(),
		/** The contract's mutation type, e.g. 'set.log'. Open; the schemas validate it. */
		type: text('type').notNull(),
		/** The client id of the row it created or changed, or its workout's. */
		entityId: uuid('entity_id').notNull(),
		/** The client id of its workout; null for a mutation that names none. */
		workoutClientId: uuid('workout_client_id'),
		/** When it happened on the device (the envelope's `at`). */
		clientAt: timestamp('client_at', { withTimezone: true }).notNull(),
		/** When the server applied it. */
		appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
		/** The request that applied it, to match the server's logs. */
		requestId: text('request_id')
	},
	(t) => [
		// A workout's applied mutations.
		index('sync_mutations_owner_workout_idx').on(t.ownerId, t.workoutClientId)
	]
);
