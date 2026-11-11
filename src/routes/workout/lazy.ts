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

/** How long afterPaint waits for a frame, on a page that paints none (hidden). */
export const AFTER_PAINT_FALLBACK_MS = 500;

/**
 * Runs `run` once, when the frame being rendered has painted: for code the first paint does not
 * show, whose requests would otherwise compete with the chunks it does show. The frame after next
 * starts once that frame is on screen, not only drawn. A hidden page paints no frame, so it runs
 * after AFTER_PAINT_FALLBACK_MS at the latest.
 */
export function afterPaint(run: () => void) {
	let done = false;
	const once = () => {
		if (done) return;
		done = true;
		run();
	};
	requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(once, 0)));
	setTimeout(once, AFTER_PAINT_FALLBACK_MS);
}
