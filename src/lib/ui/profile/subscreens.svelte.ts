/**
 * A section's sub-screens: an injury, a tick list or a class, opened inside the section's own
 * screen. Still the same section, with the same draft and the same Save, so no route of its own:
 * browser Back leaves the section (asking first when there are changes), and the sub-screen's back
 * link is the way back within it.
 */
import { getContext, setContext, tick } from 'svelte';

/** A screen a section opens inside itself: an injury, a tick list, a class. */
export interface SubScreen {
	/** Unique within the section, e.g. `injury:<key>`, `kit`, `class:<key>`. */
	id: string;
	title: string;
	/** The back link's words: the screen it returns to ("Injuries", "Schedule"). */
	back: string;
	lede?: string;
	/** The 32/38 question style ("What do you like doing?") in place of the 40/44 title. */
	statement?: boolean;
}

/**
 * The sub-screens open in a section, innermost last. The host (SectionScreen, onboarding's Step)
 * draws the innermost one's back link and title in place of its own; the editor draws its body.
 * Focus goes to the new title on open, and back to whatever opens it on close (see `close`).
 */
export class SubScreens {
	stack = $state<SubScreen[]>([]);
	#openers: (Element | null)[] = [];

	get top(): SubScreen | null {
		return this.stack.at(-1) ?? null;
	}

	open(screen: SubScreen) {
		this.#openers.push(document.activeElement);
		this.stack.push(screen);
		void tick().then(() => {
			window.scrollTo({ top: 0 });
			document.querySelector<HTMLElement>('[data-subscreen-title]')?.focus();
		});
	}

	/**
	 * Close the one on top. The focus goes back to what opened it, if it is still there; an editor
	 * that draws its screen in place of its list has unmounted it, so then to the element that
	 * opens this screen (`data-opens="<id>"`, the row in whichever list it is now), and failing
	 * that to `fallback` (Add an injury, once the injury was removed).
	 */
	close(fallback?: () => HTMLElement | null | undefined) {
		const screen = this.stack.pop();
		const opener = this.#openers.pop();
		void tick().then(() => {
			const target =
				opener instanceof HTMLElement && opener.isConnected
					? opener
					: ((screen &&
							document.querySelector<HTMLElement>(`[data-opens="${CSS.escape(screen.id)}"]`)) ??
						fallback?.());
			target?.focus();
		});
	}

	/** Close them all (the section saved and went back, or another section opened). */
	reset() {
		this.stack = [];
		this.#openers = [];
	}
}

const KEY = Symbol('subscreens');

export const provideSubScreens = () => setContext(KEY, new SubScreens());

/** The host's sub-screens; `undefined` where no host provides them (a test rendering an editor). */
export const useSubScreens = () => getContext<SubScreens | undefined>(KEY);
