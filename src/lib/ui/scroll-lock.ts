/**
 * Page scroll lock shared by every modal surface (sheets, dialogs).
 *
 * Reference-counted so nested or overlapping sheets cannot leave the page locked: the lock is
 * applied by the first holder and released only when the last holder lets go. `lockScroll`
 * returns an idempotent release function — call it on close *and* on component teardown, so a
 * route change while a sheet is open (browser Back, iOS swipe-back) still unlocks the page.
 */
let holders = 0;

export function lockScroll(): () => void {
	if (typeof document === 'undefined') return () => {};
	if (holders++ === 0) document.documentElement.style.overflow = 'hidden';
	let released = false;
	return () => {
		if (released) return;
		released = true;
		if (--holders === 0) document.documentElement.style.overflow = '';
	};
}

/** Number of active holders — exposed for tests. */
export function scrollLockHolders(): number {
	return holders;
}
