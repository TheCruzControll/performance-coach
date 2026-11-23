/**
 * Undo on a weigh-in the coach logged (the weight plan's PR 9): POST the run that logged it to the
 * weigh-in's endpoint (/api/coach/weights/[id]/undo), and say what came back. A 200 took the
 * coach's write back ('undone'). A 404, the weigh-in is gone, and a 409, it no longer holds that
 * write (the owner changed it, or it was replaced), both mean there is nothing to undo. Anything
 * else, or no answer at all (offline, a dropped connection, a server failure), is 'failed', which
 * the card can try again.
 *
 * Sending it again is safe: the server takes the write back once, so a retry after an answer that
 * was lost finds nothing and says so.
 */
type Fetch = typeof globalThis.fetch;

/** What one Undo request came back as. */
export type UndoOutcome = 'undone' | 'nothing' | 'failed';

/** Where a card is: not yet asked, on its way, or what the request came back as. */
export type UndoPhase = 'idle' | 'posting' | UndoOutcome;

export async function undoWeighIn(
	id: number,
	runId: string,
	fetch: Fetch = globalThis.fetch
): Promise<UndoOutcome> {
	let response: Response;
	try {
		response = await fetch(`/api/coach/weights/${id}/undo`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ runId })
		});
	} catch {
		return 'failed';
	}
	if (response.status === 200) return 'undone';
	if (response.status === 404 || response.status === 409) return 'nothing';
	return 'failed';
}

/**
 * One weigh-in's Undo card: its phase, which the card's words and button follow. Undo does nothing
 * while it is on its way or once it has settled into words.
 */
export class WeighInUndo {
	phase = $state<UndoPhase>('idle');
	readonly #id: number;
	readonly #runId: string;
	readonly #fetch: Fetch | undefined;

	constructor(id: number, runId: string, fetch?: Fetch) {
		this.#id = id;
		this.#runId = runId;
		this.#fetch = fetch;
	}

	/** Undo is on its way: the button is disabled and busy. */
	get posting(): boolean {
		return this.phase === 'posting';
	}

	/** Undo has said what happened in words: 'Undone' or 'Nothing to undo'. */
	get settled(): boolean {
		return this.phase === 'undone' || this.phase === 'nothing';
	}

	async undo(): Promise<void> {
		if (this.posting || this.settled) return;
		this.phase = 'posting';
		this.phase = await undoWeighIn(this.#id, this.#runId, this.#fetch);
	}
}
