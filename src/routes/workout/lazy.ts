/**
 * Code-split chunks for the workout pages: the store's write path, and later the sync engine and
 * the sheets. A deploy removes the previous build's chunks, so a page opened before it can no
 * longer load one: the page then shows 'App updated — reload to continue', which is safe because
 * everything the workout holds is in IndexedDB. The loader is the Shell's, which owns that state.
 */
import type { ChunkLoad } from '#lib/client/workout/active.svelte.ts';

/** A loader that reports a chunk that failed to load through `onStale`, and answers null. */
export function chunkLoader(onStale: (error: unknown) => void): ChunkLoad {
	return async (load) => {
		try {
			return await load();
		} catch (error) {
			onStale(error);
			return null;
		}
	};
}
