/**
 * Calls `measure` as an element or one of its children resizes, and as its children come and go:
 * how a sheet knows its content has grown taller than it (BottomSheet.svelte). Returns the stop.
 *
 * Every observe() happens in a frame callback, before the frame's ResizeObserver step, never
 * during that step: a mutation can be noticed there (a render that a ResizeObserver callback
 * causes runs in that callback's microtasks), and an element first observed then has a
 * notification the step can no longer deliver, which WebKit reports as the page error
 * 'ResizeObserver loop completed with undelivered notifications.' The element itself is observed
 * once; a child only when it appears.
 */
export function watchContentSize(el: Element, measure: () => void): () => void {
	const resized = new ResizeObserver(() => measure());
	const watched = new Set<Element>();
	const sync = () => {
		frame = 0;
		for (const child of watched) {
			if (child.parentElement === el) continue;
			resized.unobserve(child);
			watched.delete(child);
		}
		for (const child of el.children) {
			if (watched.has(child)) continue;
			watched.add(child);
			resized.observe(child);
		}
		// A child that left changes what overflows without resizing anything observed.
		measure();
	};
	let frame = requestAnimationFrame(() => {
		resized.observe(el);
		sync();
	});
	const changed = new MutationObserver(() => {
		frame ||= requestAnimationFrame(sync);
	});
	changed.observe(el, { childList: true });
	return () => {
		cancelAnimationFrame(frame);
		changed.disconnect();
		resized.disconnect();
	};
}
