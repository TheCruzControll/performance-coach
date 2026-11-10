/**
 * Today keeps today's sessions ready for a gym with no signal (the M4 plan's start-entry-points):
 * once its plan shows and the browser is idle, it saves the start kits of the sessions still to
 * do (start.ts saveKits). Saving creates 'pc-offline', so this is the rule: Today is the only
 * screen besides the workout pages that may create the database, and only while it shows
 * sessions planned for today. With none (a rest day, every session done or skipped) nothing is
 * asked for and nothing is created. Plain .ts: the saver is injected, so Today loads it lazily.
 */
import type { SessionStatus } from '#lib/domain/training/vocabulary.ts';

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
