/**
 * The last screen each app URL showed, kept in this page's memory only, so a revisit can show it
 * at once while its fresh data loads ((app)/+layout.svelte). A screen is whatever the layout
 * keeps for it (a copy of its DOM, for tab roots only); this module files one per pathname, the
 * most recently kept `limit` of them, and recalls it for that pathname with the same query only.
 *
 * Nothing is written to any storage. The memory is forgotten when the app shell goes away (sign
 * in again, a workout, any screen outside the tabs), when this tab signs out (signout.ts) and
 * when another tab does (its 'signed-out' message).
 */
/** What a screen is filed under: SvelteKit's read-only URLs as well as plain ones. */
export type ScreenUrl = Pick<URL, 'pathname' | 'search'>;

export class ScreenMemory<T> {
	readonly #kept = new Map<string, { search: string; screen: T }>();
	readonly #limit: number;

	constructor(limit: number) {
		this.#limit = limit;
	}

	/** Keep `screen` as the last one `url`'s pathname showed, replacing any earlier one. */
	keep(url: ScreenUrl, screen: T): void {
		this.#kept.delete(url.pathname);
		this.#kept.set(url.pathname, { search: url.search, screen });
		for (const oldest of this.#kept.keys()) {
			if (this.#kept.size <= this.#limit) break;
			this.#kept.delete(oldest);
		}
	}

	/** The last screen `url` showed, if it is still kept (the hash only scrolls within it). */
	recall(url: ScreenUrl): T | undefined {
		const kept = this.#kept.get(url.pathname);
		return kept?.search === url.search ? kept.screen : undefined;
	}

	forget(): void {
		this.#kept.clear();
	}

	get size(): number {
		return this.#kept.size;
	}
}

/** The app's memory: one screen per tab. */
export const screens = new ScreenMemory<readonly Node[]>(5);

/** Forget every kept screen: the account's data never outlives its session in this tab. */
export function forgetScreens(): void {
	screens.forget();
}
