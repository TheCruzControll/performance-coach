/**
 * Connectivity as reactive state (browser only): mirrors `navigator.onLine` and its
 * online/offline events.
 *
 * It is a hint, not a guarantee: a connected but unusable network ("lie-fi") still reads as
 * online, so anything that needs the network must also handle failed requests (see
 * src/hooks.client.ts, which turns network failures into the designed offline state).
 */
class Connectivity {
	/** SSR and first render assume online, so the server markup never mismatches. */
	online = $state(true);
	#started = false;

	start(): void {
		if (this.#started || typeof window === 'undefined') return;
		this.#started = true;
		this.online = navigator.onLine;
		addEventListener('online', () => (this.online = true));
		addEventListener('offline', () => (this.online = false));
	}
}

export const connectivity = new Connectivity();
