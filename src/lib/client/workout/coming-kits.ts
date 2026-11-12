/**
 * Today and Train keep the coming days' sessions ready for a gym with no signal (the M4 plan's
 * start-entry-points): once their plan shows and the browser is idle, they save the start kits of
 * the sessions still to do from today to KITS_AHEAD_DAYS after it (start.ts saveKits), so a
 * session looked at the night before starts offline the next day. Saving creates 'pc-offline',
 * so this is the rule: Today and Train are the only screens besides the workout pages that may
 * create the database, and only while sessions are still to do in those days. With none (rest
 * days ahead, every session done or skipped) nothing is asked for and nothing is created.
 * Sign-out deletes the database, these kits with it (signout.ts); the store prunes a kit a week
 * after it was saved. The screens import this module on idle, and it imports start.ts only when
 * there is a kit to save, so neither adds to a screen's initial JavaScript.
 */
import type { IsoDate } from '#lib/domain/calendar.ts';
import type { SessionStatus } from '#lib/domain/training/vocabulary.ts';

/** The days after today whose sessions are kept ready too: tomorrow and the day after. */
export const KITS_AHEAD_DAYS = 2;

/** A session of the plan on its day. */
export interface DatedSession {
	lineage: string;
	status: SessionStatus;
	date: IsoDate;
}

/** Still to do: planned, or moved to this day. */
const isToDo = (status: SessionStatus) => status === 'planned' || status === 'moved';

/**
 * The lineages to keep ready: still to do and dated from `today` to KITS_AHEAD_DAYS after it, by
 * day, in the plan's order within a day, each once (a screen may list one twice).
 */
export function comingLineages(sessions: readonly DatedSession[], today: IsoDate): string[] {
	const last = new Date(Date.parse(today) + KITS_AHEAD_DAYS * 86_400_000)
		.toISOString()
		.slice(0, 10);
	const coming = sessions
		.filter((s) => isToDo(s.status) && s.date >= today && s.date <= last)
		.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
	return [...new Set(coming.map((s) => s.lineage))];
}

/** start.ts's saveKits through the start store, opened only now: this creates 'pc-offline'. */
async function saveOnDevice(lineages: string[]): Promise<string[]> {
	const start = await import('./start.ts');
	return start.saveKits(lineages, { store: await start.openStartStore() });
}

/** The lineages saved (comingLineages); none, without calling `save`, when there are none. */
export async function saveComingKits(
	sessions: readonly DatedSession[],
	today: IsoDate,
	save: (lineages: string[]) => Promise<string[]> = saveOnDevice
): Promise<string[]> {
	const lineages = comingLineages(sessions, today);
	return lineages.length ? save(lineages) : [];
}
