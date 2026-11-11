/**
 * Today keeps today's sessions ready for a gym with no signal (the M4 plan's start-entry-points):
 * once its plan shows and the browser is idle, it saves the start kits of the sessions still to
 * do (start.ts saveKits). Saving creates 'pc-offline', so this is the rule: Today is the only
 * screen besides the workout pages that may create the database, and only while it shows
 * sessions planned for today. With none (a rest day, every session done or skipped) nothing is
 * asked for and nothing is created. Plain .ts: the saver is injected, so Today loads it lazily.
 */
import type { IsoDate } from '#lib/domain/calendar.ts';
import type { DisciplineTone } from '#lib/domain/profile/catalog.ts';
import {
	SESSION_TYPE_LABEL,
	sessionTone,
	type SessionStatus
} from '#lib/domain/training/vocabulary.ts';
import type { StartKit } from '#lib/domain/workout/index.ts';
import type { SavedKit } from './db.ts';
import { workoutPath } from './kinds.ts';
import { savedKits, type PlannedRun } from './probe.ts';

/** Still to do: planned, or moved to today. */
export const isToDo = (status: SessionStatus) => status === 'planned' || status === 'moved';

/** The lineages saved; none, without calling `save`, when no session is still to do. */
export async function saveTodayKits(
	sessions: readonly { lineage: string; status: SessionStatus }[],
	save: (lineages: string[]) => Promise<string[]>
): Promise<string[]> {
	const lineages = sessions.filter((s) => isToDo(s.status)).map((s) => s.lineage);
	return lineages.length ? save(lineages) : [];
}

// ---- Today's saved sessions, offline ---------------------------------------------------------

/**
 * The offline screen at the start URL (a launch with no signal) lists today's sessions from the
 * kits saved here, so a launch without a workout in progress can still start one: each to
 * /workout?start=<lineage>, which starts from the saved kit when the network does not answer
 * (start.ts startPlanned). Resume when it is the workout in progress on this device, Done once a
 * workout of it was completed here, Start otherwise (an abandoned one may start again).
 */
export interface OfflineSession {
	lineage: string;
	title: string;
	/** What it is in words: 'Strength · 4 exercises', 'Easy run', 'Muay Thai · 60 min'. */
	line: string;
	tone: DisciplineTone;
	/** Null once done here: History needs the server, so it offers no link. */
	action: {
		id: 'start-workout' | 'resume-workout';
		label: string;
		href: string;
	} | null;
}

/** The device's calendar day at `ms`, as start.ts dates an ad-hoc kit. */
export function deviceDay(ms: number): IsoDate {
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function lineOf(kit: StartKit): string {
	const type = SESSION_TYPE_LABEL[kit.sessionType];
	if (kit.kind === 'strength') return `${type} · ${plural(kit.exercises.length, 'exercise')}`;
	if (kit.kind === 'other' && kit.other.durationMinutes) {
		return `${type} · ${kit.other.durationMinutes} min`;
	}
	return type;
}

/** `kits` oldest first, as probe.ts savedKits reads them: Today saves them in the plan's order. */
export function offlineSessions(
	kits: readonly SavedKit[],
	runs: readonly PlannedRun[],
	today: IsoDate
): OfflineSession[] {
	const sessions: OfflineSession[] = [];
	for (const { lineage, kit } of kits) {
		if (kit.date !== today) continue;
		const mine = runs.filter((run) => run.plannedLineage === lineage);
		const active = mine.find((run) => run.status === 'in_progress');
		const done = !active && mine.some((run) => run.status === 'completed');
		const action = active
			? { id: 'resume-workout' as const, label: 'Resume', href: workoutPath(active.kind) }
			: done
				? null
				: {
						id: 'start-workout' as const,
						label: 'Start workout',
						href: `/workout?start=${encodeURIComponent(lineage)}`
					};
		const { title, sessionType } = kit;
		sessions.push({ lineage, title, line: lineOf(kit), tone: sessionTone(sessionType), action });
	}
	return sessions;
}

/** Today's saved sessions on this device, never creating its database (probe.ts). */
export async function savedToday(now: number = Date.now()): Promise<OfflineSession[]> {
	const { kits, runs } = await savedKits();
	return offlineSessions(kits, runs, deviceDay(now));
}
