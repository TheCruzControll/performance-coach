/**
 * Coaching memory read builders (M5): what repositories/coach-memory.ts runs for the coach's
 * snapshot (services/coach/memory.ts).
 * - profileSections reads the owner's small profile sections in one statement, each as a JSON
 *   list from its owner index, so the snapshot stays within its query budget however many
 *   sections Profile grows: open goals by rank, current strength baselines, exercise
 *   preferences, equipment and active injuries.
 * - The record builders read what happened since: pain reports, recovery notes, decisions,
 *   proposals, reviews and coach notes, each newest first and bounded. Every day they return is
 *   the owner's local day (their profile's time zone, UTC without one), worked out in SQL so the
 *   snapshot needs no extra query for it.
 * - COACH_MEMORY_INDEXES names the index each builder is shaped for (null: a relation too small
 *   to want one, as recovery notes are, one a day); `pnpm db:explain` gates them
 *   (scripts/explain/history.explain.ts).
 * Nothing runs until a builder is awaited; await them in turn on one connection.
 */
import {
	and,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	sql,
	type SQL,
	type SQLWrapper
} from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type {
	BaselineKind,
	Equipment,
	Lift,
	Sentiment,
	Severity
} from '../../../domain/profile/catalog';
import type {
	Decider,
	PreferenceSource,
	ProposalStatus
} from '../../../domain/training/vocabulary';
import {
	athleteProfiles,
	coachNotes,
	coachProposals,
	coachThreads,
	cycleReviews,
	equipmentProfiles,
	exercisePreferences,
	exercises,
	injuries,
	owners,
	painReports,
	programmingDecisions,
	programs,
	recoveryNotes,
	strengthBaselines,
	trainingGoals,
	weeklyReviews
} from '../schema';
import type { Executor } from '../types';

/**
 * The index each builder is shaped for; each JSON list probes its table's owner index. Null: no
 * index, as the relation stays small.
 */
export const COACH_MEMORY_INDEXES: Readonly<Record<string, string | readonly string[] | null>> = {
	profileSections: 'owners_pkey',
	painReportsSince: 'pain_reports_owner_reported_idx',
	// At most one a day: a year is a few hundred rows.
	recoveryNotesSince: null,
	latestWeeklyReviews: 'weekly_reviews_owner_week_uq',
	// Through the owner's programs (programs_owner_active_uq covers only the active one).
	latestCycleReview: 'cycle_reviews_block_uq',
	recentDecisions: 'programming_decisions_program_idx',
	// Open ones by status, decided ones by when they were decided.
	recentProposals: ['coach_proposals_owner_status_idx', 'coach_proposals_owner_closed_idx'],
	recentNotes: 'coach_notes_owner_kind_idx'
};

export interface MemoryGoalRow {
	id: string;
	title: string;
	priority: number;
	targetDate: string | null;
	eventDate: string | null;
}
export interface MemoryBaselineRow {
	id: string;
	lift: Lift;
	customLabel: string;
	kind: BaselineKind;
	value: number;
	unit: 'kg' | 'lb';
	achievedOn: string | null;
}
export interface MemoryPreferenceRow {
	id: string;
	exercise: string;
	sentiment: Sentiment;
	reason: string | null;
	source: PreferenceSource;
}
export interface MemoryEquipmentRow {
	equipment: Equipment[];
	homeEquipment: Equipment[];
}
export interface MemoryInjuryRow {
	id: string;
	bodyArea: string;
	severity: Severity;
	notes: string | null;
	avoid: string[];
}

/** `fields` of the rows `where` picks, as a JSON list in `order` ([] for none). */
function jsonList<Row>(table: PgTable, fields: Record<string, SQLWrapper>, where: SQL, order: SQL) {
	const pairs = sql.join(
		Object.entries(fields).map(([key, column]) => sql`${sql.raw(`'${key}'`)}, ${column}`),
		sql`, `
	);
	return sql<
		Row[]
	>`(select coalesce(json_agg(json_build_object(${pairs}) order by ${order}), '[]'::json) from ${table} where ${where})`;
}

/** The owner's profile sections the snapshot reads: one row, or none for an unknown owner. */
export function profileSections(db: Executor, ownerId: string) {
	const g = trainingGoals;
	const b = strengthBaselines;
	const p = exercisePreferences;
	const i = injuries;
	const e = equipmentProfiles;
	return db
		.select({
			goals: jsonList<MemoryGoalRow>(
				g,
				{
					id: g.id,
					title: g.title,
					priority: g.priority,
					targetDate: g.targetDate,
					eventDate: g.eventDate
				},
				and(eq(g.ownerId, ownerId), isNotNull(g.priority))!,
				sql`${g.priority}`
			),
			baselines: jsonList<MemoryBaselineRow>(
				b,
				{
					id: b.id,
					lift: b.lift,
					customLabel: b.customLabel,
					kind: b.kind,
					value: b.value,
					unit: b.unit,
					achievedOn: b.achievedOn
				},
				and(eq(b.ownerId, ownerId), isNull(b.supersededAt))!,
				sql`${b.lift}, ${b.customLabel}`
			),
			// Dislikes first (they constrain the program most), then oldest first.
			preferences: jsonList<MemoryPreferenceRow>(
				p,
				{
					id: p.id,
					exercise: p.exercise,
					sentiment: p.sentiment,
					reason: p.reason,
					source: p.source
				},
				eq(p.ownerId, ownerId),
				sql`${p.sentiment} = 'dislike' desc, ${p.createdAt}, ${p.id}`
			),
			equipment: sql<MemoryEquipmentRow | null>`(select json_build_object('equipment', ${e.equipment}, 'homeEquipment', ${e.homeEquipment}) from ${e} where ${eq(e.ownerId, ownerId)})`,
			injuries: jsonList<MemoryInjuryRow>(
				i,
				{ id: i.id, bodyArea: i.bodyArea, severity: i.severity, notes: i.notes, avoid: i.avoid },
				and(eq(i.ownerId, ownerId), eq(i.active, true))!,
				sql`${i.createdAt}, ${i.id}`
			)
		})
		.from(owners)
		.where(eq(owners.id, ownerId));
}

export type ProfileSectionsRow = Awaited<ReturnType<typeof profileSections>>[number];

// ---- Records ------------------------------------------------------------------------------

/** The owner's time zone, as their profile names it; UTC without a profile. */
const zoneOf = (ownerId: string) =>
	sql`coalesce((select ${athleteProfiles.timeZone} from ${athleteProfiles} where ${eq(athleteProfiles.ownerId, ownerId)}), 'UTC')`;

/** The owner's local day `instant` falls on, as YYYY-MM-DD. */
const dayOf = (instant: SQLWrapper, ownerId: string) =>
	sql<string>`to_char(${instant} at time zone ${zoneOf(ownerId)}, 'YYYY-MM-DD')`;

/** The instant the owner's local day `day` (YYYY-MM-DD) begins. */
const startOf = (day: string, ownerId: string) =>
	sql`(${day}::date::timestamp at time zone ${zoneOf(ownerId)})`;

/** The owner's pain reports from their local day `since` on, newest first; deleted ones never. */
export function painReportsSince(db: Executor, ownerId: string, since: string, limit: number) {
	const p = painReports;
	return db
		.select({
			id: p.id,
			workoutId: p.workoutId,
			date: dayOf(p.reportedAt, ownerId),
			exercise: exercises.name,
			area: p.bodyArea,
			severity: p.severity,
			action: p.action,
			note: p.note
		})
		.from(p)
		.leftJoin(exercises, eq(exercises.id, p.exerciseId))
		.where(
			and(eq(p.ownerId, ownerId), gte(p.reportedAt, startOf(since, ownerId)), isNull(p.deletedAt))
		)
		.orderBy(desc(p.reportedAt), desc(p.id))
		.limit(limit);
}

/** The owner's recovery notes from `since` on, newest first. */
export function recoveryNotesSince(db: Executor, ownerId: string, since: string, limit: number) {
	const r = recoveryNotes;
	return db
		.select({
			id: r.id,
			date: r.notedOn,
			sleepHours: r.sleepHours,
			soreness: r.soreness,
			energy: r.energy,
			stress: r.stress,
			note: r.note
		})
		.from(r)
		.where(and(eq(r.ownerId, ownerId), gte(r.notedOn, since)))
		.orderBy(desc(r.notedOn), desc(r.createdAt), desc(r.id))
		.limit(limit);
}

/**
 * The owner's newest weekly reviews, live revisions only: superseded_at is null repeats the
 * predicate of the partial weekly_reviews_owner_week_uq.
 */
export function latestWeeklyReviews(db: Executor, ownerId: string, limit: number) {
	const w = weeklyReviews;
	return db
		.select({
			id: w.id,
			date: w.weekStartsOn,
			summary: w.summary,
			proposalId: w.proposalId,
			snapshotVersion: w.snapshotVersion,
			snapshot: w.snapshot
		})
		.from(w)
		.where(and(eq(w.ownerId, ownerId), isNull(w.supersededAt)))
		.orderBy(desc(w.weekStartsOn))
		.limit(limit);
}

/**
 * The owner's newest cycle review, through their programs, live revisions only (the predicate of
 * the partial cycle_reviews_block_uq).
 */
export function latestCycleReview(db: Executor, ownerId: string) {
	const c = cycleReviews;
	return db
		.select({
			id: c.id,
			date: dayOf(c.createdAt, ownerId),
			summary: c.summary,
			proposalId: c.proposalId,
			snapshotVersion: c.snapshotVersion,
			snapshot: c.snapshot
		})
		.from(c)
		.innerJoin(programs, eq(programs.id, c.programId))
		.where(and(eq(programs.ownerId, ownerId), eq(c.ownerId, ownerId), isNull(c.supersededAt)))
		.orderBy(desc(c.createdAt), desc(c.id))
		.limit(1);
}

/**
 * The owner's newest decisions with their why, `limit` of them: the programming decisions of
 * their programs, and the coach's decisions on their goals and preferences (coach_decision
 * notes, which the coach writes when it applies an accepted proposal or the owner's own words).
 */
export function recentDecisions(db: Executor, ownerId: string, limit: number) {
	const d = programmingDecisions;
	const n = coachNotes;
	const programDecisions = db
		.select({
			source: sql<'decision' | 'note'>`'decision'`.as('source'),
			id: sql<string>`${d.id}::text`.as('id'),
			at: sql<Date>`${d.createdAt}`.as('at'),
			date: dayOf(d.createdAt, ownerId).as('date'),
			kind: sql<string>`${d.kind}`.as('kind'),
			decider: sql<Decider>`${d.decidedBy}`.as('decider'),
			what: sql<string>`${d.summary}`.as('what'),
			why: sql<string>`${d.why}`.as('why')
		})
		.from(d)
		.innerJoin(programs, eq(programs.id, d.programId))
		.where(eq(programs.ownerId, ownerId))
		.orderBy(desc(d.createdAt), desc(d.id))
		.limit(limit);
	const coachDecisions = db
		.select({
			source: sql<'decision' | 'note'>`'note'`.as('source'),
			id: sql<string>`${n.id}::text`.as('id'),
			at: sql<Date>`${n.createdAt}`.as('at'),
			date: dayOf(n.createdAt, ownerId).as('date'),
			kind: sql<string>`${n.body} ->> 'kind'`.as('kind'),
			decider: sql<Decider>`'coach'`.as('decider'),
			what: sql<string>`${n.body} ->> 'what'`.as('what'),
			why: sql<string>`${n.body} ->> 'why'`.as('why')
		})
		.from(n)
		.where(and(eq(n.ownerId, ownerId), eq(n.kind, 'coach_decision')))
		.orderBy(desc(n.createdAt), desc(n.id))
		.limit(limit);
	return programDecisions
		.unionAll(coachDecisions)
		.orderBy(sql`at desc, source, id desc`)
		.limit(limit);
}

/**
 * The owner's open proposals, newest first, then those decided from their local day `since` on,
 * most recently decided first, with the owner's note on the decision.
 */
export function recentProposals(
	db: Executor,
	ownerId: string,
	{ since, pending, decided }: { since: string; pending: number; decided: number }
) {
	const p = coachProposals;
	const columns = (open: boolean) => ({
		isOpen: sql<boolean>`${sql.raw(String(open))}`.as('is_open'),
		id: sql<string>`${p.id}`.as('id'),
		at: sql<Date>`${open ? p.createdAt : p.closedAt}`.as('at'),
		kind: sql<string>`${p.kind}`.as('kind'),
		title: sql<string>`${p.title}`.as('title'),
		status: sql<ProposalStatus>`${p.status}`.as('status'),
		decidedOn: sql<string | null>`${open ? sql`null` : dayOf(p.closedAt, ownerId)}`.as(
			'decided_on'
		),
		decisionNote: sql<string | null>`${p.decisionNote}`.as('decision_note'),
		/** The rules provenance a review stored (evidence.source); null for the coach's own. */
		source: sql<unknown>`${p.evidence} -> 'source'`.as('source')
	});
	const pendingRows = db
		.select(columns(true))
		.from(p)
		.where(and(eq(p.ownerId, ownerId), eq(p.status, 'proposed')))
		.orderBy(desc(p.createdAt), desc(p.id))
		.limit(pending);
	const decidedRows = db
		.select(columns(false))
		.from(p)
		.where(
			and(
				eq(p.ownerId, ownerId),
				sql`${p.status} <> 'proposed'`,
				gte(p.closedAt, startOf(since, ownerId))
			)
		)
		.orderBy(desc(p.closedAt), desc(p.id))
		.limit(decided);
	return pendingRows.unionAll(decidedRows).orderBy(sql`is_open desc, at desc, id desc`);
}

/**
 * The owner's newest coach notes of one kind (thread summaries, workout analyses). A note about a
 * thread (body.threadId) opened with one of `hiddenEntries` is left out.
 */
export function recentNotes(
	db: Executor,
	ownerId: string,
	kind: string,
	limit: number,
	hiddenEntries: readonly string[] = []
) {
	const n = coachNotes;
	const t = coachThreads;
	const hidden =
		hiddenEntries.length === 0
			? undefined
			: sql`not exists (${db
					.select({ one: sql`1` })
					.from(t)
					.where(
						and(
							sql`${t.id}::text = ${n.body}->>'threadId'`,
							eq(t.ownerId, ownerId),
							inArray(sql`${t.entry}->>'from'`, [...hiddenEntries])
						)
					)})`;
	return db
		.select({ id: n.id, date: dayOf(n.createdAt, ownerId), summary: n.summary, body: n.body })
		.from(n)
		.where(and(eq(n.ownerId, ownerId), eq(n.kind, kind), hidden))
		.orderBy(desc(n.createdAt), desc(n.id))
		.limit(limit);
}

export type MemoryPainRow = Awaited<ReturnType<typeof painReportsSince>>[number];
export type MemoryRecoveryRow = Awaited<ReturnType<typeof recoveryNotesSince>>[number];
export type MemoryReviewRow = Awaited<ReturnType<typeof latestWeeklyReviews>>[number];
export type MemoryDecisionRow = Awaited<ReturnType<typeof recentDecisions>>[number];
export type MemoryProposalRow = Awaited<ReturnType<typeof recentProposals>>[number];
export type MemoryNoteRow = Awaited<ReturnType<typeof recentNotes>>[number];
