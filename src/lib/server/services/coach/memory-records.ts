/**
 * The record half of the coaching memory (services/coach/memory.ts builds the profile half): what
 * happened since the owner set up, in at most MEMORY_RECORDS_QUERIES queries, each section newest
 * first and bounded by MEMORY_RECORD_LIMITS, so the snapshot's cap (domain/coach/memory-format.ts)
 * cuts what matters least.
 * - pain reports from the last MEMORY_RECORD_DAYS days: exercise, body area, severity, what the
 *   owner chose, the day and the workout (its source opens it in History). A pain report is never
 *   a preference, so it is listed here and nowhere in the profile.
 * - recovery notes over the same days: sleep, soreness, energy, stress and the owner's note
 * - decisions with their why: the programming decisions of the owner's programs and the coach's
 *   decisions on their goals and preferences (coach_decision notes)
 * - proposals still waiting, then those decided over the same days, with the owner's note on the
 *   decision (a rejection's reason)
 * - the newest weekly reviews and the newest cycle review
 * - the newest thread summaries and workout analyses the coach wrote down. The snapshot opens a
 *   segment, so the summaries it lists are of other conversations (or of this one's earlier
 *   segments, which a summary closes).
 * Every day is the owner's local day. Stored text stays plain here; memory-format wraps it as
 * untrusted_text. Queries run one at a time (docs/architecture.md).
 */
import { addDays, type IsoDate } from '../../../domain/calendar';
import type {
	MemoryNote,
	MemoryPainReport,
	MemoryReview,
	MemorySnapshot
} from '../../../domain/coach/memory';
import {
	createCoachMemoryRepository,
	type MemoryRecoveryRow,
	type MemoryReviewRow
} from '../../db/repositories/coach-memory';
import type { Executor } from '../../db/types';
import { resolveDeps, type CoachDeps } from './shared';

/** The most queries the record half sends. */
export const MEMORY_RECORDS_QUERIES = 8;

/**
 * The days, today included, that pain reports, recovery notes and decided proposals are listed
 * for. An owner's choice.
 */
export const MEMORY_RECORD_DAYS = 28;

/** The most items each record section lists. An owner's choice. */
export const MEMORY_RECORD_LIMITS = Object.freeze({
	painReports: 10,
	recoveryNotes: 7,
	decisions: 8,
	pendingProposals: 5,
	decidedProposals: 5,
	weeklyReviews: 2,
	threadSummaries: 3,
	analyses: 3
});

/** The coach_notes kinds memory reads (thread-summaries adds thread_summary's schema). */
export const MEMORY_NOTE_KINDS = Object.freeze({
	threadSummary: 'thread_summary',
	analysis: 'workout_analysis'
});

/** A recovery note in a sentence: what the owner filled in, then their note. */
function recoveryText(r: MemoryRecoveryRow): string {
	const scale = (label: string, value: number | null) =>
		value === null ? [] : [`${label} ${value}/5`];
	return [
		...(r.sleepHours === null ? [] : [`slept ${r.sleepHours} h`]),
		...scale('soreness', r.soreness),
		...scale('energy', r.energy),
		...scale('stress', r.stress),
		...(r.note === null ? [] : [r.note])
	].join('; ');
}

type PainRow = Awaited<
	ReturnType<ReturnType<typeof createCoachMemoryRepository>['painReportsSince']>
>[number];

const painReportOf = (p: PainRow): MemoryPainReport => ({
	date: p.date,
	exercise: p.exercise,
	area: p.area,
	severity: p.severity,
	action: p.action,
	note: p.note,
	source: { type: 'pain_report', id: p.id, date: p.date, workoutId: p.workoutId }
});

const noteOf = (row: { id: string; date: string; summary: string }): MemoryNote => ({
	date: row.date,
	text: row.summary,
	source: { type: 'note', id: row.id, date: row.date }
});

const reviewOf = (scope: MemoryReview['scope'], row: MemoryReviewRow): MemoryReview => ({
	scope,
	date: row.date,
	summary: row.summary,
	source: { type: 'review', id: row.id, date: row.date }
});

/** The record sections of the coaching memory as of `today`, the owner's local day. */
export async function loadMemoryRecords(
	ownerId: string,
	today: IsoDate,
	db: Executor
): Promise<MemorySnapshot['records']> {
	const repo = createCoachMemoryRepository(db);
	const limits = MEMORY_RECORD_LIMITS;
	const since = addDays(today, 1 - MEMORY_RECORD_DAYS);
	const pain = await repo.painReportsSince(ownerId, since, limits.painReports);
	const recovery = await repo.recoveryNotesSince(ownerId, since, limits.recoveryNotes);
	const decisions = await repo.recentDecisions(ownerId, limits.decisions);
	const proposals = await repo.recentProposals(ownerId, {
		since,
		pending: limits.pendingProposals,
		decided: limits.decidedProposals
	});
	const weekly = await repo.latestWeeklyReviews(ownerId, limits.weeklyReviews);
	const cycle = await repo.latestCycleReview(ownerId);
	const summaries = await repo.recentNotes(
		ownerId,
		MEMORY_NOTE_KINDS.threadSummary,
		limits.threadSummaries
	);
	const analyses = await repo.recentNotes(ownerId, MEMORY_NOTE_KINDS.analysis, limits.analyses);

	return {
		painReports: pain.map(painReportOf),
		recoveryNotes: recovery.map((r) => ({
			date: r.date,
			text: recoveryText(r),
			source: { type: 'date', id: r.date }
		})),
		decisions: decisions.map((d) => ({
			date: d.date,
			kind: d.kind,
			decider: d.decider,
			what: d.what,
			why: d.why,
			source: { type: d.source, id: d.id, date: d.date }
		})),
		proposals: proposals.map((p) => ({
			kind: p.kind,
			title: p.title,
			status: p.status,
			decidedOn: p.decidedOn,
			decisionNote: p.decisionNote,
			source: { type: 'proposal', id: p.id }
		})),
		// Newest first, whatever their scope.
		reviews: [
			...weekly.map((row) => reviewOf('week', row)),
			...(cycle ? [reviewOf('cycle', cycle)] : [])
		].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
		threadSummaries: summaries.map(noteOf),
		analyses: analyses.map(noteOf)
	};
}

/**
 * The owner's pain reports from the last MEMORY_RECORD_DAYS days as of `today`, newest first, at
 * most `limit`: what memory lists, for get_training_preferences. One query.
 */
export async function listRecentPainReports(
	ownerId: string,
	{ today, limit }: { today: IsoDate; limit: number },
	deps: CoachDeps = {}
): Promise<MemoryPainReport[]> {
	const { db } = resolveDeps(deps);
	const since = addDays(today, 1 - MEMORY_RECORD_DAYS);
	const rows = await createCoachMemoryRepository(db).painReportsSince(ownerId, since, limit);
	return rows.map(painReportOf);
}
