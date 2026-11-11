/**
 * Today's saved sessions, offline: the offline screen's list of the kits Today and Train saved on
 * this device (coming-kits.ts), never creating its database (probe.ts).
 */
import type { IsoDate } from '#lib/domain/calendar.ts';
import type { DisciplineTone } from '#lib/domain/profile/catalog.ts';
import { SESSION_TYPE_LABEL, sessionTone } from '#lib/domain/training/vocabulary.ts';
import type { StartKit } from '#lib/domain/workout/index.ts';
import type { SavedKit } from './db.ts';
import { workoutPath } from './kinds.ts';
import { savedKits, type PlannedRun } from './probe.ts';

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

/** `kits` oldest first, as probe.ts savedKits reads them: saved in the plan's order (coming-kits.ts). */
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
