/**
 * One of Train's code-split sheets (the plate calculator, the plan): fetched on first intent
 * (pointerdown, hover), on open, or for its `?tool=` on arrival, so Train ships and hydrates
 * without it. A tap made before it arrives is kept: the sheet opens when it does. A failed fetch
 * is forgotten, so the next tap imports again.
 *
 * After a failure, a tap on Retry (or on the opener again) imports again in place, which WebKit
 * fetches anew because the sheet's code has no modulepreload tag (a failed one WebKit never
 * fetches again, reloads included: vite.config.ts). Chromium keeps a failed module fetch for the
 * document's lifetime, and after a deploy the old chunk is gone: if the import fails again while
 * online, Train reloads asking for the sheet (`?tool=…`), which opens once its code arrives.
 * Offline, the notice stays.
 */
import type { Component } from 'svelte';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any sheet's props
export class LazySheet<Props extends Record<string, any>> {
	/** The sheet once its code has arrived; until then a dynamic component that renders nothing. */
	component = $state.raw<Component<Props> | null>(null);
	/** Asked for: it shows once its code has arrived. */
	open = $state(false);
	/** A tap could not fetch it: the opener's notice offers Retry. */
	failed = $state(false);

	#load: () => Promise<{ default: Component<Props> }>;
	#tool: string;
	#fetching: Promise<unknown> | null = null;
	/** A tap after a reported failure, with the screen still here: failing again online reloads. */
	#retrying = false;

	/** `load` imports the sheet; `tool` is its `?tool=` value. */
	constructor(load: () => Promise<{ default: Component<Props> }>, tool: string) {
		this.#load = load;
		this.#tool = tool;
	}

	/** Tapped, its code still on its way. */
	get busy() {
		return this.open && !this.component;
	}

	/** Fetch its code, once. Kept apart from the import() expression: Vite moves
	 * `import(…).then(…)` whole into its preloader, whose own failures would skip these handlers. */
	prefetch = () => {
		if (this.#fetching) return;
		const fetching = (this.#fetching = this.#load());
		fetching.then(
			(module) => (this.component = module.default),
			() => {
				this.#fetching = null;
				// Resolved against Train's own URL: the same screen, asking for the sheet.
				if (this.#retrying && this.open && navigator.onLine)
					return location.replace(`?tool=${this.#tool}`);
				// A failed tap is reported; a failed prefetch (hover) says nothing, and never takes
				// away a notice already shown.
				this.failed ||= this.open;
				this.open = false;
			}
		);
	};

	/** Open it: a tap on its opener or on Retry, or its `?tool=` on arrival. */
	show = () => {
		this.#retrying ||= this.failed;
		this.failed = false;
		this.open = true;
		this.prefetch();
	};

	/** Train is going: a late failure must not pull the owner back to it. */
	leave() {
		this.#retrying = false;
	}
}
