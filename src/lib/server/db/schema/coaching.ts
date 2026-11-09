/**
 * Coaching memory (PRD §4, §11; M3 lays the tables, M5 and M6 fill them): what the coach proposed
 * and what each weekly and cycle review found.
 *
 *   coach_proposals   a suggested change, proposed → accepted, rejected, applied or superseded (M5)
 *   weekly_reviews    one per owner and week (M6)
 *   cycle_reviews     one per block, naming the version that plans the next block (M6)
 *
 * Exercise likes and dislikes stay in M2's exercise_preferences (profile.ts), now linked to the
 * library. Programming decisions are in programs.ts.
 *
 * - Tables only, with lifecycle CHECKs: repositories and guards come with M5 and M6. Every row
 *   carries owner_id (ownerRef), so the test cleanup clears it with the owner.
 * - CHECKs cover the closed proposal status and coherence. A proposal's kind is open: M5 names
 *   its kinds and validates them.
 * - A proposal and a review keep what they were written from as data (payload and evidence, a
 *   snapshot of the figures), so they read the same after the log is edited.
 * - Programs and versions are referenced by foreign key; they are never deleted. A block is
 *   named by its lineage, which outlives the edits that copy it (ADR 0010).
 * - M5 (coach-proposals-db) ties a proposal to the conversation, run and tool call that made it,
 *   and adds its payload's version and hash, diff, impact, decision, revision and supersession.
 *   Guards (drizzle/<n>_coach_proposals_guards.sql): a proposal is inserted 'proposed'; its
 *   content never changes; its status only moves forward; an applied, rejected or superseded row
 *   is frozen; DELETE is refused. The lifecycle columns (applied_*, closed_at, decision_note,
 *   superseded_reason) are left to the CHECKs below. Only test and reset code bypasses the guards
 *   (ADR 0010), and the backup restore loads rows with user triggers disabled.
 * - agent-runs.ts names coach_proposals for agent_tool_calls.proposal_id, so the two modules
 *   import each other; every cross-table reference is a lazy callback, so either loads first.
 */
import { sql } from 'drizzle-orm';
import {
	check,
	date,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
	uuid,
	type AnyPgColumn
} from 'drizzle-orm/pg-core';
import { SUPERSEDED_REASONS, type SupersededReason } from '../../../domain/coach/vocabulary';
import { PROPOSAL_STATUSES, type ProposalStatus } from '../../../domain/training/vocabulary';
import { agentRuns } from './agent-runs';
import { coachThreads } from './coach';
import { createdAt, inList, ownerRef, updatedAt } from './columns';
import { programs, programVersions } from './programs';

/** Free-form structured data (a proposal's change and evidence, a review's figures). */
type Json = Record<string, unknown>;

/** A decision note's longest, in characters (the owner's optional reason for a rejection). */
export const DECISION_NOTE_MAX = 500;

/** What applying a proposal changed, when it made no program version. */
export const APPLIED_REF_KINDS = ['goal', 'preference', 'substitution', 'program'] as const;
export type AppliedRefKind = (typeof APPLIED_REF_KINDS)[number];
export interface AppliedRef {
	kind: AppliedRefKind;
	id: string;
}

/** Something the coach suggests; nothing changes until the owner accepts and it is applied. */
export const coachProposals = pgTable(
	'coach_proposals',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		ownerId: ownerRef(),
		status: text('status').$type<ProposalStatus>().notNull().default('proposed'),
		/** What it would change (a program edit, a preference, a goal). Open; M5 validates it. */
		kind: text('kind').notNull(),
		title: text('title').notNull(),
		/** What would change, in a sentence. */
		summary: text('summary').notNull(),
		/** Why, in words the owner reads; never empty. */
		rationale: text('rationale').notNull(),
		/** The change itself, as the service that applies it reads it. */
		payload: jsonb('payload').$type<Json>().notNull(),
		/** What the coach read (workouts, reviews, notes). */
		evidence: jsonb('evidence').$type<Json>(),
		/** The program it would change, and the version it was proposed against. */
		programId: uuid('program_id').references(() => programs.id),
		baseVersionId: uuid('base_version_id').references(() => programVersions.id),
		/** The version applying it made, when it made one. */
		appliedVersionId: uuid('applied_version_id').references(() => programVersions.id),
		/** What applying it changed otherwise (a goal, a preference, a substitution). */
		appliedRef: jsonb('applied_ref').$type<AppliedRef>(),
		/** The conversation, run and tool call that proposed it; null for a proposal from elsewhere. */
		threadId: uuid('thread_id').references(() => coachThreads.id),
		runId: uuid('run_id').references(() => agentRuns.id),
		toolUseId: text('tool_use_id'),
		/** The payload schema's version (PAYLOAD_VERSION) and payloadHash(payload). */
		payloadVersion: integer('payload_version'),
		payloadHash: text('payload_hash'),
		/** What would change, as the card shows it, and what it would affect. */
		diff: jsonb('diff').$type<Json>(),
		impact: jsonb('impact').$type<Json>(),
		/** When it left 'proposed'; the guard stamps it on that move when the update does not. */
		closedAt: timestamp('closed_at', { withTimezone: true }),
		/** The owner's note on the decision (an optional reason for a rejection). */
		decisionNote: text('decision_note'),
		/** The proposal this one revises ('Ask for changes'). */
		revisionOf: uuid('revision_of').references((): AnyPgColumn => coachProposals.id),
		/** Why it was superseded: set exactly when it is. */
		supersededReason: text('superseded_reason').$type<SupersededReason>(),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		// The owner's open proposals, newest first.
		index('coach_proposals_owner_status_idx').on(
			t.ownerId,
			t.status,
			t.createdAt.desc().nullsFirst()
		),
		// Every proposal of the owner's, newest first (the inbox with no status filter).
		index('coach_proposals_owner_created_idx').on(
			t.ownerId,
			t.createdAt.desc().nullsFirst(),
			t.id.desc().nullsFirst()
		),
		// The owner's decided proposals, most recently decided first (the turn context, memory).
		index('coach_proposals_owner_closed_idx')
			.on(t.ownerId, t.closedAt.desc().nullsFirst(), t.id.desc().nullsFirst())
			.where(sql`${t.closedAt} is not null`),
		// A conversation's proposals, in order.
		index('coach_proposals_thread_idx').on(t.threadId, t.createdAt),
		check('coach_proposals_status_ck', inList('status', PROPOSAL_STATUSES)),
		check(
			'coach_proposals_applied_ck',
			sql`(${t.status} = 'applied') = (${t.appliedVersionId} is not null or ${t.appliedRef} is not null)`
		),
		check(
			'coach_proposals_applied_ref_ck',
			// IS TRUE: a missing key is null, which a CHECK would otherwise let through.
			sql`${t.appliedRef} is null or (jsonb_typeof(${t.appliedRef}) = 'object' and ${t.appliedRef} ->> 'kind' in (${sql.raw(APPLIED_REF_KINDS.map((kind) => `'${kind}'`).join(', '))}) and jsonb_typeof(${t.appliedRef} -> 'id') = 'string' and char_length(${t.appliedRef} ->> 'id') > 0) is true`
		),
		check(
			'coach_proposals_superseded_ck',
			sql`(${t.status} = 'superseded') = (${t.supersededReason} is not null)`
		),
		check('coach_proposals_superseded_reason_ck', inList('superseded_reason', SUPERSEDED_REASONS)),
		// CHECKs run in name order: an unknown status is left to coach_proposals_status_ck to name.
		check(
			'coach_proposals_closed_ck',
			sql`(${t.status} = 'proposed') = (${t.closedAt} is null) or not (${inList('status', PROPOSAL_STATUSES)})`
		),
		check(
			'coach_proposals_decision_ck',
			sql`${t.decisionNote} is null or ${t.status} <> 'proposed'`
		),
		check(
			'coach_proposals_decision_note_ck',
			sql`char_length(${t.decisionNote}) between 1 and ${sql.raw(String(DECISION_NOTE_MAX))}`
		),
		check('coach_proposals_payload_version_ck', sql`${t.payloadVersion} >= 1`),
		check('coach_proposals_payload_hash_ck', sql`${t.payloadHash} ~ '^[0-9a-f]{16}$'`),
		check('coach_proposals_tool_use_ck', sql`char_length(${t.toolUseId}) > 0`),
		check(
			'coach_proposals_program_ck',
			sql`${t.programId} is not null or (${t.baseVersionId} is null and ${t.appliedVersionId} is null)`
		),
		check('coach_proposals_kind_ck', sql`char_length(${t.kind}) > 0`),
		check('coach_proposals_title_ck', sql`char_length(${t.title}) > 0`),
		check('coach_proposals_summary_ck', sql`char_length(${t.summary}) > 0`),
		check('coach_proposals_rationale_ck', sql`char_length(${t.rationale}) > 0`)
	]
);

/** A Monday-to-Sunday week, reviewed: planned against done, trends and what to adjust. */
export const weeklyReviews = pgTable(
	'weekly_reviews',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		ownerId: ownerRef(),
		/** The week's Monday (weekStartOf in the profile's time zone). */
		weekStartsOn: date('week_starts_on', { mode: 'string' }).notNull(),
		/** The figures the review was written from, as they were then. */
		snapshot: jsonb('snapshot').$type<Json>().notNull(),
		/** The verdict, in a sentence. */
		summary: text('summary').notNull(),
		/** The coach's write-up, once written. */
		narrative: text('narrative'),
		/** The adjustments it recommended for next week. */
		proposalId: uuid('proposal_id').references(() => coachProposals.id),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		uniqueIndex('weekly_reviews_owner_week_uq').on(t.ownerId, t.weekStartsOn),
		// A Monday, so one week has one date to be unique by.
		check('weekly_reviews_week_ck', sql`extract(isodow from ${t.weekStartsOn}) = 1`),
		check('weekly_reviews_summary_ck', sql`char_length(${t.summary}) > 0`),
		check('weekly_reviews_narrative_ck', sql`char_length(${t.narrative}) > 0`)
	]
);

/** A block (cycle), reviewed at its end: progress, fatigue and what the next block changes. */
export const cycleReviews = pgTable(
	'cycle_reviews',
	{
		id: uuid('id').primaryKey().defaultRandom(),
		ownerId: ownerRef(),
		programId: uuid('program_id')
			.notNull()
			.references(() => programs.id),
		/** The block's lineage (program_blocks.lineage_id), the same in every version. */
		blockLineageId: uuid('block_lineage_id').notNull(),
		snapshot: jsonb('snapshot').$type<Json>().notNull(),
		summary: text('summary').notNull(),
		narrative: text('narrative'),
		/** The version that planned the next block, once it is planned. */
		nextVersionId: uuid('next_version_id').references(() => programVersions.id),
		proposalId: uuid('proposal_id').references(() => coachProposals.id),
		createdAt: createdAt(),
		updatedAt: updatedAt()
	},
	(t) => [
		uniqueIndex('cycle_reviews_block_uq').on(t.programId, t.blockLineageId),
		check('cycle_reviews_summary_ck', sql`char_length(${t.summary}) > 0`),
		check('cycle_reviews_narrative_ck', sql`char_length(${t.narrative}) > 0`)
	]
);
