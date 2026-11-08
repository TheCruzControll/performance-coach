/**
 * The coaching memory (PRD §4; the coach memory and proposals ADR): one deterministic snapshot of
 * what the coach knows, built from structured records and never from replayed chat. It opens
 * every conversation segment (agent/memory/load.ts) and fills 'What the coach knows'.
 *
 * This builds the profile half, in at most MEMORY_PROFILE_QUERIES queries:
 * - goals by rank; the active program, its version, week and phase (M3's getCurrentProgram)
 * - the last RECENT_DAYS days, planned against done; skipped sessions are no longer planned
 * - current strength baselines, measured or estimated
 * - simple trends: the analytics service's trendsOf over the same workouts, complete weeks only.
 *   Running distance is left to get_performance_trends, as its mileage read would break the
 *   budget.
 * - exercise preferences with their source and reason (only explicit ones are stored: a machine
 *   being taken is a substitution, never a preference); equipment; active injuries and the
 *   movements they say to avoid
 * The record sections are empty until coach-memory-records adds its loader.
 *
 * Equipment and injuries have no source type of their own: they cite a 'preference' ref with an
 * `equipment.` or `injury.` id (the owner's training preferences, as get_training_preferences
 * groups them).
 *
 * Queries run one at a time (docs/architecture.md), so the turn may hand this a transaction.
 */
import { addDays, mondayOf, type IsoDate } from '../../../domain/calendar';
import type { MemoryDay, MemorySnapshot, MemoryTrend } from '../../../domain/coach/memory';
import type { SourceRef } from '../../../domain/coach/sources';
import {
	BODY_AREA_LABEL,
	EQUIPMENT,
	EQUIPMENT_LABEL,
	LIFT_LABEL
} from '../../../domain/profile/catalog';
import {
	createCoachMemoryRepository,
	type MemoryEquipmentRow
} from '../../db/repositories/coach-memory';
import { TREND_WEEKS, trendsOf, type Trend } from '../analytics/index';
import { getCurrentProgram } from '../programs';
import { getSessionsInRange, type SessionsInRange } from '../training/history';
import { resolveDeps, type CoachDeps } from './shared';

/** The most queries the profile half sends; coach-memory-records' half adds its own. */
export const MEMORY_PROFILE_QUERIES = 9;
/** The days, today included, the snapshot sets planned against done. An owner's choice. */
export const RECENT_DAYS = 14;

const emptyRecords = (): MemorySnapshot['records'] => ({
	painReports: [],
	recoveryNotes: [],
	decisions: [],
	proposals: [],
	reviews: [],
	threadSummaries: [],
	analyses: []
});

const round = (value: number) => Math.round(value * 10) / 10;

/** A trend with enough data, in a sentence: the earlier and later halves' weekly means. */
function trendOf({ method, unit, change, sources }: Trend): MemoryTrend[] {
	if (!change.enoughData) return [];
	const pct = change.pct === null ? '' : ` (${change.pct > 0 ? '+' : ''}${round(change.pct)}%)`;
	return [
		{
			subject: method,
			direction: change.direction,
			summary: `${round(change.earlier)} to ${round(change.later)} ${unit} a week${pct}, weeks of ${change.from} to ${change.to}`,
			source: sources[0]!
		}
	];
}

/** The days from `from` to today with anything planned or done, newest first. */
function recentDays({ planned, logged }: SessionsInRange, from: IsoDate): MemoryDay[] {
	const days = new Map<IsoDate, MemoryDay>();
	const day = (date: IsoDate) => {
		const found = days.get(date) ?? {
			date,
			planned: [],
			done: [],
			source: { type: 'date', id: date }
		};
		days.set(date, found);
		return found;
	};
	for (const s of planned)
		if (s.scheduledOn >= from && s.status !== 'skipped')
			day(s.scheduledOn).planned.push({
				title: s.title,
				source: { type: 'session', id: s.lineageId, date: s.scheduledOn }
			});
	for (const w of logged)
		if (w.date >= from && w.status === 'completed')
			day(w.date).done.push({
				title: w.title,
				source: { type: 'workout', id: w.id, date: w.date }
			});
	return [...days.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
}

/** Gym equipment, then what is only at home, in the catalogue's order. */
function equipmentOf(row: MemoryEquipmentRow | null) {
	if (!row) return [];
	return EQUIPMENT.filter((key) => row.equipment.includes(key) || row.homeEquipment.includes(key))
		.sort((a, b) => Number(!row.equipment.includes(a)) - Number(!row.equipment.includes(b)))
		.map((key) => ({
			name: `${EQUIPMENT_LABEL[key]}${row.equipment.includes(key) ? '' : ' (home)'}`,
			source: { type: 'preference', id: `equipment.${key}` } satisfies SourceRef
		}));
}

/** The profile half of the coaching memory as of `today`, the owner's local day. */
export async function getCoachingMemory(
	ownerId: string,
	{ today }: { today: IsoDate },
	deps: CoachDeps = {}
): Promise<MemorySnapshot> {
	const { db } = resolveDeps(deps);
	const profile = await createCoachMemoryRepository(db).profileSections(ownerId);
	const program = await getCurrentProgram(ownerId, today, { db });
	// One read for both: the trend weeks reach further back than the recent days.
	const trendTo = addDays(mondayOf(today), -1);
	const trendFrom = addDays(trendTo, 1 - 7 * TREND_WEEKS);
	const recentFrom = addDays(today, 1 - RECENT_DAYS);
	const sessions = await getSessionsInRange(
		ownerId,
		{ from: trendFrom < recentFrom ? trendFrom : recentFrom, to: today },
		{ db }
	);
	const trends = trendsOf(
		sessions.logged.filter((w) => w.date >= trendFrom && w.date <= trendTo),
		trendTo,
		null
	);
	const injuries = profile?.injuries ?? [];
	const injuryRef = (id: string): SourceRef => ({ type: 'preference', id: `injury.${id}` });

	return {
		asOf: today,
		profile: {
			goals: (profile?.goals ?? []).map((g) => ({
				rank: g.priority,
				title: g.title,
				targetDate: g.targetDate ?? g.eventDate,
				source: { type: 'goal', id: g.id }
			})),
			program: program && {
				name: program.title,
				versionNumber: program.version.number,
				week: program.currentWeek,
				weeks: program.plannedWeeks,
				phase: program.blocks.find((b) => b.startsOn <= today && today <= b.endsOn)?.phase ?? null,
				source: { type: 'version', id: String(program.version.number) }
			},
			recentDays: recentDays(sessions, recentFrom),
			baselines: (profile?.baselines ?? []).map((b) => ({
				exercise: b.customLabel || LIFT_LABEL[b.lift],
				value: b.value,
				unit: b.unit,
				kind: b.kind,
				date: b.achievedOn,
				source: { type: 'baseline', id: b.id }
			})),
			trends: trends.status === 'ok' ? trends.trends.flatMap(trendOf) : [],
			preferences: (profile?.preferences ?? []).map((p) => ({
				exercise: p.exercise,
				stance: p.sentiment,
				origin: p.source,
				reason: p.reason,
				source: { type: 'preference', id: p.id }
			})),
			equipment: equipmentOf(profile?.equipment ?? null),
			injuries: injuries.map((i) => ({
				area: i.bodyArea,
				severity: i.severity,
				note: i.notes,
				source: injuryRef(i.id)
			})),
			avoid: injuries.flatMap((i) =>
				i.avoid.map((movement) => ({
					movement,
					reason: `${BODY_AREA_LABEL[i.bodyArea as keyof typeof BODY_AREA_LABEL] ?? i.bodyArea} injury`,
					source: injuryRef(i.id)
				}))
			)
		},
		records: emptyRecords()
	};
}
