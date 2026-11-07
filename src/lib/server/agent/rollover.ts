/**
 * When a conversation moves to its next segment (the turn's hook), before the turn stores its
 * owner message so that message opens the new segment. A stub: it rolls over only on a change of
 * prompt version, with no summary. thread-summaries replaces this file: a segment then also ends
 * at SEGMENT's token and message limits, and its summary note opens the next one.
 */
import type { CoachThread } from '../services/coach/threads.ts';
import { startSegment } from '../services/coach/threads.ts';
import type { CoachDeps } from '../services/coach/shared.ts';

export interface RolloverInput {
	ownerId: string;
	thread: CoachThread;
	promptVersion: string;
	/** The active program version the next segment starts on. */
	programVersionId: string | null;
	deps: CoachDeps;
}

/** The thread to continue on, and the summary the next segment's preamble carries. */
export async function rollover(
	input: RolloverInput
): Promise<{ thread: CoachThread; summary: string | null }> {
	const { ownerId, thread, promptVersion, programVersionId, deps } = input;
	if (thread.segmentPromptVersion === promptVersion) return { thread, summary: null };
	const next = await startSegment(ownerId, thread.id, { promptVersion, programVersionId }, deps);
	return { thread: next, summary: null };
}
