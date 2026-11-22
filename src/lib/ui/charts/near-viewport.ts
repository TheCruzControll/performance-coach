/** One screen above and below the viewport. */
export const NEAR_MARGIN = '100% 0px';

/**
 * Runs `run` once `target` comes within NEAR_MARGIN of the viewport; at once where
 * IntersectionObserver is missing. Returns a stop function: after it, `run` never runs.
 */
export function whenNear(target: Element, run: () => void): () => void {
	if (typeof IntersectionObserver === 'undefined') {
		run();
		return () => {};
	}
	const observer = new IntersectionObserver(
		(entries) => {
			if (!entries.some((entry) => entry.isIntersecting)) return;
			observer.disconnect();
			run();
		},
		{ rootMargin: NEAR_MARGIN }
	);
	observer.observe(target);
	return () => observer.disconnect();
}
