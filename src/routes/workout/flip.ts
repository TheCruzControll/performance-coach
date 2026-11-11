/**
 * Keeps the strength view's blocks from jumping when a change moves them (PRD §7: the next
 * exercise's card is taller or shorter, the logger changes, the rest pill rises with it): a FLIP.
 * `places` reads where each block is before the change; `glide`, in the frame after (before it
 * paints), shows each block that moved where it was and slides it to its new place on the
 * compositor. It animates the `translate` property, so the swipe's transform on the card is left
 * alone, and a block caught mid-slide starts again from where it is seen. With motion reduced they
 * move at once.
 */

/** A slide's length and curve: the design system's base duration and standard ease. */
const SLIDE = { duration: 240, easing: 'cubic-bezier(0.2, 0, 0, 1)' };

/** Under a pixel is layout rounding, not a move. */
const NOISE_PX = 1;

/**
 * How far a block that moved from `before` to `after` (its top, px) starts from its new place, or
 * 0 for none. A block stuck to the foot (`footed`, the logger below 1024 px) only rises: shown
 * higher than it is, its foot would leave a gap above the screen's edge.
 */
export function slideFrom(before: number, after: number, footed = false): number {
	const offset = before - after;
	if (Math.abs(offset) < NOISE_PX) return 0;
	if (footed && offset < 0) return 0;
	return offset;
}

/** Where each block is now (its top as seen, a running slide included). */
export function places(blocks: Iterable<HTMLElement>): Map<HTMLElement, number> {
	const tops = new Map<HTMLElement, number>();
	for (const block of blocks) tops.set(block, block.getBoundingClientRect().top);
	return tops;
}

const running = new WeakMap<HTMLElement, Animation>();

/** Slides each block of `before` that has moved since from where it was; `footed` as slideFrom. */
export function glide(before: Map<HTMLElement, number>, footed: (block: HTMLElement) => boolean) {
	if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
	const blocks = [...before.keys()].filter((block) => block.isConnected);
	// Their new places without any slide: every read first, then every write.
	for (const block of blocks) running.get(block)?.cancel();
	const offsets = blocks.map((block) =>
		slideFrom(before.get(block)!, block.getBoundingClientRect().top, footed(block))
	);
	blocks.forEach((block, i) => {
		const offset = offsets[i]!;
		if (offset === 0) return;
		running.set(
			block,
			block.animate([{ translate: `0 ${offset}px` }, { translate: '0 0' }], SLIDE)
		);
	});
}
