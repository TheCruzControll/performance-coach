/**
 * Managing conversations from the Coach screens (rename, archive, unarchive and the Archived
 * list), shared by ThreadList, its sheets and the archived conversation's banner. Client-safe:
 * the endpoints (api/coach/threads) answer in these shapes.
 *
 * Owner decision (M5 plan, open question 'Should conversations be deletable?'): no. A
 * conversation is archived and found again under Archived conversations, never deleted; the
 * actions below are the only ones the endpoint takes, and the database refuses DELETE.
 */
import type { ThreadRowView } from './words';

/** What POST /api/coach/threads/<id> does: the only changes a conversation takes. */
export const THREAD_ACTIONS = ['rename', 'archive', 'unarchive'] as const;
export type ThreadAction = (typeof THREAD_ACTIONS)[number];

/** The longest name the owner may give a conversation (the database's THREAD_TITLE_MAX). */
export const THREAD_TITLE_CHARS = 120;

/** Archived conversations per page of the Archived list. */
export const ARCHIVED_PAGE = 20;

/** A page of the Archived list, newest archived first; `next` continues it, null at its end. */
export interface ArchivedPage {
	threads: ThreadRowView[];
	next: string | null;
}

/** A conversation as an action left it. */
export interface ManagedThread {
	id: string;
	title: string;
	archived: boolean;
}

export type ThreadActionBody =
	{ action: 'rename'; title: string } | { action: 'archive' | 'unarchive' };

/**
 * Send one action for conversation `id`: the conversation as it now stands, or null when it did
 * not go through (offline, refused or a server failure), so the caller offers Retry.
 */
export async function manageThread(
	id: string,
	body: ThreadActionBody
): Promise<ManagedThread | null> {
	try {
		const response = await fetch(`/api/coach/threads/${id}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body)
		});
		if (!response.ok) return null;
		return ((await response.json()) as { thread: ManagedThread }).thread;
	} catch {
		return null;
	}
}
