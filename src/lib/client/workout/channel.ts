/**
 * The tabs' channel (the offline workout sync ADR, 'Tabs'): BroadcastChannel 'pc-workout' tells
 * the other tabs of this device what one of them did to the shared store.
 * - changed: a workout's rows, outbox or device state were written; closed: likewise, and the
 *   workout is no longer in progress (finished or abandoned). Other tabs re-read it.
 * - purged: the session was lost and the server's copies were deleted (purgeServerCopies). Other
 *   tabs re-read everything and show the signed-out state.
 * - signed-out: sign-out is about to delete 'pc-offline'. Other tabs drop their in-memory workout
 *   and close their store for good, so the deletion is never blocked and nothing recreates it.
 * A channel never hears its own messages. In /workout's static graph, so it stays small.
 */
export const TAB_CHANNEL = 'pc-workout';

export type TabMessage =
	{ type: 'changed' | 'closed'; workoutId: string } | { type: 'purged' | 'signed-out' };

export interface TabChannel {
	post(message: TabMessage): void;
	/** The other tabs' messages; anything else on the channel is ignored. */
	listen(listener: (message: TabMessage) => void): () => void;
	close(): void;
}

const TYPES: readonly string[] = ['changed', 'closed', 'purged', 'signed-out'];

export function isTabMessage(data: unknown): data is TabMessage {
	const m = data as Partial<Record<'type' | 'workoutId', unknown>> | null;
	if (typeof m !== 'object' || m === null || !TYPES.includes(m.type as string)) return false;
	return (m.type !== 'changed' && m.type !== 'closed') || typeof m.workoutId === 'string';
}

/** The channel, or null where BroadcastChannel is missing (each tab then reads on its own). */
export function openTabChannel(
	name = TAB_CHANNEL,
	Channel: typeof BroadcastChannel | null | undefined = globalThis.BroadcastChannel
): TabChannel | null {
	if (!Channel) return null;
	const channel = new Channel(name);
	return {
		post(message) {
			try {
				channel.postMessage(message);
			} catch {
				// closed already: there is no one left to tell
			}
		},
		listen(listener) {
			const onMessage = ({ data }: MessageEvent) => {
				if (isTabMessage(data)) listener(data);
			};
			channel.addEventListener('message', onMessage);
			return () => channel.removeEventListener('message', onMessage);
		},
		close: () => channel.close()
	};
}

/** One message from a page that holds no store: sign-out's 'signed-out', the e2e helpers. */
export function broadcast(message: TabMessage, name = TAB_CHANNEL): void {
	const channel = openTabChannel(name);
	channel?.post(message);
	channel?.close();
}
