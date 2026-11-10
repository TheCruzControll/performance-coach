/**
 * Gives focus back to what opened a modal surface, once the surface has closed.
 *
 * WebKit's focus() skips the style update it needs while a stylesheet is still loading (one a
 * lazily loaded component has just linked): the opener still reads as inert from the modal dialog
 * that has just closed, so the call does nothing and focus is left nowhere. CI saw it when the app
 * shell's idle-time resume bar linked its stylesheets as a sheet closed. So while focus is nowhere
 * it tries again each frame, for about a second; it stops as soon as focus is somewhere, the
 * opener's or wherever the user has put it since.
 */

/** About a second of frames: far longer than a stylesheet from this origin takes. */
export const RETURN_FOCUS_FRAMES = 60;

/** The parts of an element the return uses. */
export type Focusable = Pick<HTMLElement, 'focus' | 'isConnected'>;

/**
 * Focus `target`, and again on each frame while `nowhere()` says focus has not landed anywhere
 * (the page's body, or the closed surface itself).
 */
export function returnFocus(
	target: Focusable,
	nowhere: () => boolean,
	frame: (callback: () => void) => unknown = (callback) => requestAnimationFrame(callback),
	frames = RETURN_FOCUS_FRAMES
): void {
	target.focus({ preventScroll: true });
	if (frames > 0 && target.isConnected && nowhere()) {
		frame(() => returnFocus(target, nowhere, frame, frames - 1));
	}
}
