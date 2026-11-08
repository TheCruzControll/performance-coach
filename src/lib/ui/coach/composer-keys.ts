/**
 * The composer's keyboard (PRD §12, M5 plan): on a fine pointer, Enter sends and Shift+Enter
 * adds a newline; on a phone's on-screen keyboard, Return always adds a newline and Send sends.
 *
 * Which keyboard is in use is read from the last pointer that touched the composer, because the
 * layout rules forbid asking matchMedia about the pointer (docs/design-system.md, Pointer &
 * hover): a finger or a pen means the on-screen keyboard; a mouse, or no pointer at all (the
 * composer reached with Tab), means a hardware keyboard.
 */

/**
 * The longest message the composer accepts, in characters. The server's limit is the same
 * (OWNER_MESSAGE_MAX_CHARS in services/coach/threads.ts); scripts/coach-composer-limit.test.ts
 * keeps the two equal.
 */
export const COMPOSER_MAX_CHARS = 4_000;

/** From this many characters the composer shows its count beside the limit. */
export const COMPOSER_COUNT_FROM = 3_600;

export type ComposerPointer = 'fine' | 'coarse';

/** The pointer an event came from, as the composer reads it. */
export const pointerOf = (pointerType: string): ComposerPointer =>
	pointerType === 'mouse' ? 'fine' : 'coarse';

export interface ComposerKey {
	key: string;
	shiftKey: boolean;
	ctrlKey: boolean;
	metaKey: boolean;
	altKey: boolean;
	/** An input method (Japanese, Chinese, dictation) is composing: its Enter is not ours. */
	isComposing: boolean;
}

/**
 * Whether a keydown in the composer sends the message: Enter on a fine pointer, with no
 * modifier; Ctrl or Cmd with Enter on any pointer (an iPad's hardware keyboard). Anything else
 * keeps the textarea's own behaviour, so Shift+Enter and the phone's Return add a newline.
 */
export function sendsOnKey(event: ComposerKey, pointer: ComposerPointer): boolean {
	if (event.key !== 'Enter' || event.isComposing || event.altKey) return false;
	if (event.ctrlKey || event.metaKey) return !event.shiftKey;
	return pointer === 'fine' && !event.shiftKey;
}

/** The count the composer shows near the limit: '3,950 / 4,000', or null below it. */
export function composerCount(text: string): string | null {
	if (text.length < COMPOSER_COUNT_FROM) return null;
	const group = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
	return `${group(text.length)} / ${group(COMPOSER_MAX_CHARS)}`;
}
