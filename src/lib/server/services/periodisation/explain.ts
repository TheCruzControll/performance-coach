/**
 * 'Why this day?' (m7/14 placement-why): the decisions, across the program's versions, that put
 * each session of a week on its day, for the disclosure under its card on Train. Imported by path:
 * services/index.ts does not re-export it, and the folder has no index file.
 *
 * - One read: the program's decisions of WHY_KINDS whose `affected` names a session of the week
 *   (repositories/periodisation.ts), newest first. A decision the generator wrote once for every
 *   week it shaped names each of those sessions, so it explains each of them.
 * - Per session, the owner's own moves come first, then the rest newest first, at most
 *   MAX_WHY_ITEMS. A session no decision names gets no entry, so no disclosure.
 * - The generator's priority trade-offs that keep a clash (CLASH_KEPT_RULES) come back as they
 *   are too (`tradeoffs`): the week's evaluation turns them into the resolutions of the findings
 *   they explain (evaluate.ts). Its other trade-offs, such as a long run's length, explain no
 *   clash, so they stay out of the findings.
 * - Owner-scoped through the program: another owner's program returns nothing.
 */
import type { IsoDate } from '../../../domain/calendar';
import { weekdayOf } from '../../../domain/calendar';
import { WEEKDAY_INFO } from '../../../domain/profile/catalog';
import {
	DECIDER_LABEL,
	DECISION_KIND_LABEL,
	type DecisionKind
} from '../../../domain/training/vocabulary';
import { createPeriodisationRepository } from '../../db/repositories/periodisation';
import { measure } from '../../observability/timing';
import { resolveDeps, type TrainingDeps } from '../training/shared';
import type { TradeoffDecision } from './evaluate';

/** The decisions that say why a session sits on its day (m7-plan, placement-why). */
export const WHY_KINDS = [
	'session_moved',
	'schedule_repaired',
	'priority_tradeoff',
	'interference_resolved',
	'maintenance_dose',
	'session_placed',
	'commitment_placed'
] as const satisfies readonly DecisionKind[];

/**
 * The priority trade-offs that keep a clash the week then shows as a finding: placement.ts's on
 * the session that keeps its day, and schedule repair's (schedule/repair.ts).
 */
export const CLASH_KEPT_RULES: readonly string[] = [
	'placement.priority_kept',
	'schedule.priority_kept'
];

/**
 * Decision (m7-plan, placement-why): the most decisions one session's disclosure lists. Older
 * ones stay in the program's History.
 */
export const MAX_WHY_ITEMS = 6;

/** One decision in the disclosure, in words. */
export interface WhyItem {
	/** The decision's kind as a label: 'Session moved'. */
	kind: string;
	summary: string;
	why: string;
	/** Who decided: 'You', 'Coach' or 'Programming rules'. */
	decidedBy: string;
	/** The number of the version it produced. */
	version: number;
}

export interface PlacementWhy {
	/** 'Why Tuesday?' */
	title: string;
	/** The owner's moves first, then newest first; never empty. */
	items: WhyItem[];
}

export interface PlacementWhyView {
	/** By session lineage, for each session a decision names. */
	byLineage: Record<string, PlacementWhy>;
	/** The priority trade-offs among them that keep a clash, newest first, for the week's evaluation. */
	tradeoffs: TradeoffDecision[];
}

export interface PlacementAt {
	programId: string;
	/** The week's sessions: each one's lineage and the date it is on now. */
	sessions: readonly { lineage: string; date: IsoDate }[];
}

/** The why of each session in `at`. An unknown or foreign program explains nothing. */
export async function getPlacementWhy(
	ownerId: string,
	{ programId, sessions }: PlacementAt,
	deps: TrainingDeps = {}
): Promise<PlacementWhyView> {
	const { db } = resolveDeps(deps);
	const rows = await measure('periodisation', () =>
		createPeriodisationRepository(db).decisionsForLineages(
			ownerId,
			programId,
			sessions.map((s) => s.lineage),
			// Enough for every session's list even when no decision names two of them.
			{ kinds: WHY_KINDS, limit: MAX_WHY_ITEMS * sessions.length }
		)
	);
	// Stable: the owner's own decisions first, each group still newest first.
	const ordered = rows.toSorted(
		(a, b) => Number(a.decidedBy !== 'owner') - Number(b.decidedBy !== 'owner')
	);
	const byLineage: Record<string, PlacementWhy> = {};
	for (const { lineage, date } of sessions) {
		const items = ordered
			.filter((row) => row.affected.includes(lineage))
			.slice(0, MAX_WHY_ITEMS)
			.map((row): WhyItem => ({
				kind: DECISION_KIND_LABEL[row.kind] ?? row.kind,
				summary: row.summary,
				why: row.why,
				decidedBy: DECIDER_LABEL[row.decidedBy],
				version: row.version
			}));
		if (items.length) {
			byLineage[lineage] = { title: `Why ${WEEKDAY_INFO[weekdayOf(date)].label}?`, items };
		}
	}
	const tradeoffs = rows
		.filter(
			(row) => row.kind === 'priority_tradeoff' && CLASH_KEPT_RULES.includes(row.ruleKey ?? '')
		)
		.map(({ why, affected }) => ({ why, affected }));
	return { byLineage, tradeoffs };
}
