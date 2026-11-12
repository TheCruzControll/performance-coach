/**
 * Periodisation read builders (m7-plan, LAYERS): each is one keyed query that
 * repositories/periodisation.ts runs, shaped for the index PERIODISATION_INDEXES names. Later M7
 * slices add their builders here. Nothing runs until a builder is awaited; await them in turn on
 * one connection.
 */
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DecisionKind } from '../../../domain/training/vocabulary';
import { programmingDecisions, programs, programVersions } from '../schema';
import type { Executor } from '../types';

/**
 * The index each builder is shaped for. decisionsForLineages filters `affected` under the
 * program index: a program writes a few hundred decisions a year, and a GIN on `affected` waits
 * for periodisation-explain's migration slot, added only if a gate needs it (m7-plan, SCHEMA).
 */
export const PERIODISATION_INDEXES = {
	decisionsForLineages: 'programming_decisions_program_idx'
} as const;

/**
 * The program's decisions that name any of `lineages` in `affected`, newest first, of `kinds`
 * when given, at most `limit`, each with the number of the version it produced. Owner-scoped
 * through the program, so another owner's program returns nothing. `lineages` travels as one
 * jsonb parameter (as programs.ts's affectedNodes), so the statement never grows with the week.
 */
export function decisionsForLineages(
	db: Executor,
	ownerId: string,
	programId: string,
	lineages: readonly string[],
	{ kinds, limit }: { kinds?: readonly DecisionKind[]; limit: number }
) {
	const d = programmingDecisions;
	const named = sql`array(select jsonb_array_elements_text(${JSON.stringify(lineages)}::jsonb))`;
	return db
		.select({
			id: d.id,
			kind: d.kind,
			ruleKey: d.ruleKey,
			summary: d.summary,
			why: d.why,
			decidedBy: d.decidedBy,
			affected: d.affected,
			/** The event's day, for a decision about one (taper_planned's, event_taper's evidence). */
			date: sql<string | null>`${d.evidence}->>'date'`,
			version: programVersions.number
		})
		.from(d)
		.innerJoin(programs, eq(programs.id, d.programId))
		.innerJoin(programVersions, eq(programVersions.id, d.versionId))
		.where(
			and(
				eq(d.programId, programId),
				eq(programs.ownerId, ownerId),
				kinds ? inArray(d.kind, [...kinds]) : undefined,
				sql`${d.affected} ?| ${named}`
			)
		)
		.orderBy(desc(d.createdAt), desc(d.id))
		.limit(limit);
}

export type LineageDecisionRow = Awaited<ReturnType<typeof decisionsForLineages>>[number];
