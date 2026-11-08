/**
 * When a drag across the current exercise is a swipe to another one (PRD §7): far enough, or
 * quick enough, and clearly sideways, so a vertical scroll never changes the exercise. The
 * thresholds are named so the real-device checklist can tune them in one place.
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
