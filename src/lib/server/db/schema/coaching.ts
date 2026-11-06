/**
 * Coaching memory (PRD §4, §11; M3 lays the tables, M5 and M6 fill them): what the coach proposed
 * and what each weekly and cycle review found.
 *
 *   coach_proposals   a suggested change, proposed → accepted or rejected → applied (M5)
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
 */
import { sql } from 'drizzle-orm';
import { check, date, index, jsonb, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { PROPOSAL_STATUSES, type ProposalStatus } from '../../../domain/training/vocabulary';
import { createdAt, inList, ownerRef, updatedAt } from './columns';
import { programs, programVersions } from './programs';

/** Free-form structured data (a proposal's change and evidence, a review's figures). */
type Json = Record<string, unknown>;

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
		/** The version applying it made: set exactly when it is applied. */
		appliedVersionId: uuid('applied_version_id').references(() => programVersions.id),
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
		check('coach_proposals_status_ck', inList('status', PROPOSAL_STATUSES)),
		check(
			'coach_proposals_applied_ck',
			sql`(${t.status} = 'applied') = (${t.appliedVersionId} is not null)`
		),
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
