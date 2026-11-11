/**
 * The swipe across the current exercise (PRD §7). While the pointer is down the card is the
 * finger: it follows 1:1 once the drag is clearly sideways, and gives way less and less past the
 * first or the last exercise. On release a drag far enough, or quick enough, and clearly sideways
 * moves to the neighbour, so a vertical scroll never changes the exercise; then a spring seeded
 * with the release velocity brings the card to rest. The thresholds are named so the real-device
 * checklist can tune them in one place.
 */

/** A swipe travels at least this share of the swiped area's width… */
export const SWIPE_DISTANCE_SHARE = 0.25;
/** …but never less than this, in px, on a narrow area. */
export const SWIPE_MIN_DISTANCE = 56;
/** A flick: at least this fast (px per ms) over at least SWIPE_FLICK_DISTANCE px. */
export const SWIPE_FLICK_VELOCITY = 0.5;
export const SWIPE_FLICK_DISTANCE = 24;
/** Sideways means the horizontal travel is at least this many times the vertical. */
export const SWIPE_SLOPE = 2;
/** The drag picks its axis after this many px, so a tap or a scroll never moves the card. */
export const SWIPE_LOCK_DISTANCE = 8;
/** How stiff the edge feels: iOS's rubber-band constant. */
export const RUBBER_BAND = 0.55;
/** The release velocity is read over the drag's last this many ms. */
export const VELOCITY_WINDOW_MS = 100;
/** The settling spring, critically damped: it lands without a wobble, in about 300 ms. */
export const SPRING = { stiffness: 500, damping: 2 * Math.sqrt(500) } as const;
/** The fastest release the spring takes on, in px per ms: a hard human flick. Faster input (a
 * synthetic drag) would only fling the card past rest. */
export const SPRING_MAX_VELOCITY = 4;
/** However wild the fling, the card is at rest within this. */
export const SPRING_MAX_MS = 1_000;

/** Which neighbours the current exercise has. */
export interface Ends {
	previous: boolean;
	next: boolean;
}

/** A pointer position along the drag, at an event's timeStamp. */
export interface Sample {
	x: number;
	t: number;
}

/**
 * The exercise a drag moves to, relative to the current one: +1 (dragged left: the next), -1
 * (dragged right: the previous), or 0 (not a swipe). dx and dy in px, ms its duration, width the
 * swiped area's.
 */
export function swipeStep(dx: number, dy: number, ms: number, width: number): -1 | 0 | 1 {
	const distance = Math.abs(dx);
	if (distance < SWIPE_SLOPE * Math.abs(dy)) return 0;
	const far = distance >= Math.max(SWIPE_MIN_DISTANCE, width * SWIPE_DISTANCE_SHARE);
	const flick =
		distance >= SWIPE_FLICK_DISTANCE && distance / Math.max(1, ms) >= SWIPE_FLICK_VELOCITY;
	if (!far && !flick) return 0;
	return dx < 0 ? 1 : -1;
}

/** The axis a drag has picked: none yet, sideways (the card follows) or vertical (a scroll). */
export function dragAxis(dx: number, dy: number): 'x' | 'y' | null {
	if (Math.hypot(dx, dy) < SWIPE_LOCK_DISTANCE) return null;
	return Math.abs(dx) >= SWIPE_SLOPE * Math.abs(dy) ? 'x' : 'y';
}

/** How far the card gives way when dragged `offset` px past an end: less and less, under width. */
export function rubberBand(offset: number, width: number): number {
	if (offset === 0) return 0;
	const distance = Math.abs(offset);
	return Math.sign(offset) * (1 - 1 / ((distance * RUBBER_BAND) / width + 1)) * width;
}

/** The card's offset for a sideways drag of dx px: 1:1 toward a neighbour, resisted past an end. */
export function dragOffset(dx: number, width: number, ends: Ends): number {
	const open = dx < 0 ? ends.next : ends.previous;
	return open ? dx : rubberBand(dx, width);
}

/** Adds a sample, dropping those older than the velocity window. */
export function pushSample(samples: Sample[], sample: Sample): void {
	samples.push(sample);
	while (samples.length > 2 && sample.t - samples[1]!.t > VELOCITY_WINDOW_MS) samples.shift();
}

/** The drag's velocity at release, in px per ms, over the window's samples. */
export function releaseVelocity(samples: readonly Sample[]): number {
	const last = samples.at(-1);
	if (!last) return 0;
	const first = samples.find((sample) => last.t - sample.t <= VELOCITY_WINDOW_MS) ?? last;
	const ms = last.t - first.t;
	return ms > 0 ? (last.x - first.x) / ms : 0;
}

/**
 * Where a released drag goes: `delta` as swipeStep (0 when that side has no exercise), and the
 * offset the card settles `from`. Moving on, the card shows its new exercise where that neighbour
 * would be, beside the old card's offset, so it enters from the side the finger pulled it.
 */
export function release(drag: {
	offset: number;
	dx: number;
	dy: number;
	ms: number;
	width: number;
	ends: Ends;
}): { delta: -1 | 0 | 1; from: number } {
	const { offset, width, ends } = drag;
	const step = swipeStep(drag.dx, drag.dy, drag.ms, width);
	const open = step > 0 ? ends.next : step < 0 ? ends.previous : false;
	if (!open) return { delta: 0, from: offset };
	return { delta: step, from: offset + step * width };
}

/**
 * The spring from `from` to `to` (px), leaving at `velocity` px per ms (at most
 * SPRING_MAX_VELOCITY either way), as one offset per 60 Hz
 * frame (WAAPI keyframes, played linearly) and its duration in ms. It stops once within half a px
 * and nearly still, or at SPRING_MAX_MS; the last offset is always `to`.
 */
export function springFrames(
	from: number,
	to: number,
	velocity: number
): { offsets: number[]; duration: number } {
	const frame = 1000 / 60;
	const substeps = 8;
	const dt = frame / substeps / 1000;
	let x = from - to;
	let v = Math.max(-SPRING_MAX_VELOCITY, Math.min(SPRING_MAX_VELOCITY, velocity)) * 1000;
	const offsets = [from];
	const settled = () => Math.abs(x) < 0.5 && Math.abs(v) < 20;
	while (!settled() && offsets.length * frame < SPRING_MAX_MS) {
		for (let i = 0; i < substeps; i++) {
			v += (-SPRING.stiffness * x - SPRING.damping * v) * dt;
			x += v * dt;
		}
		offsets.push(to + x);
	}
	offsets[offsets.length - 1] = to;
	return { offsets, duration: (offsets.length - 1) * frame };
}
