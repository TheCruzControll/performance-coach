/**
 * The sync status for the screens (the offline workout sync ADR): Saved, Saving…, Offline ·
 * N pending, Retrying in n s, N need attention, Sign in to sync · N waiting, Finish adding your
 * passkey. The words are the screens'; this holds the engine's latest OutboxStatus as reactive
 * state. It imports only types, so a screen showing it does not load the engine (sync.ts), which
 * starts on idle.
 *
 * A thin wrapper, as the client README's M4 rule asks: $state.raw over the engine's immutable
 * status objects, never $state.snapshot, and the logic stays in sync.ts and outbox-rules.ts.
 */
import type { OutboxStatus } from './outbox-rules.ts';
import type { SyncEngine } from './sync.ts';

/** While retrying, the countdown is read again every second. */
export const RETRY_TICK_MS = 1000;

class LiveOutboxStatus {
	/** null until an engine has read the outbox. */
	current = $state.raw<OutboxStatus | null>(null);
	#tick: ReturnType<typeof setTimeout> | undefined;

	/** Mirrors `engine` until the function it returns is called. */
	follow(engine: Pick<SyncEngine, 'status' | 'onChange'>): () => void {
		const read = () => {
			clearTimeout(this.#tick);
			this.current = engine.status();
			if (this.current?.state === 'retrying') this.#tick = setTimeout(read, RETRY_TICK_MS);
		};
		const unsubscribe = engine.onChange(read);
		read();
		return () => {
			unsubscribe();
			clearTimeout(this.#tick);
		};
	}
}

export const outboxStatus = new LiveOutboxStatus();
