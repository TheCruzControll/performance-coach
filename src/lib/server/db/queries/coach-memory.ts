/**
 * Coaching memory read builders (M5): what repositories/coach-memory.ts runs for the coach's
 * snapshot (services/coach/memory.ts).
 * - profileSections reads the owner's small profile sections in one statement, each as a JSON
 *   list from its owner index, so the snapshot stays within its query budget however many
 *   sections Profile grows: open goals by rank, current strength baselines, exercise
 *   preferences, equipment and active injuries.
 * - COACH_MEMORY_INDEXES names the index each builder is shaped for; coach-explain (m5/54) adds
 *   them to `pnpm db:explain`.
 * Nothing runs until a builder is awaited; await them in turn on one connection.
 */
import { and, eq, isNotNull, isNull, sql, type SQL, type SQLWrapper } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type {
	BaselineKind,
	Equipment,
	Lift,
	Sentiment,
	Severity
} from '../../../domain/profile/catalog';
import type { PreferenceSource } from '../../../domain/training/vocabulary';
import {
	equipmentProfiles,
	exercisePreferences,
	injuries,
	owners,
	strengthBaselines,
	trainingGoals
} from '../schema';
import type { Executor } from '../types';

/** The index each builder is shaped for; each JSON list probes its table's owner index. */
export const COACH_MEMORY_INDEXES = {
	profileSections: 'owners_pkey'
} as const;

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
