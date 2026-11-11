/**
 * One coach turn as the conversation shows it while it streams (M5 plan, coach-thread-stream):
 * the owner's message at once, 'Thinking…' until the first step or words, activity chips as tools
 * run, each block's words as they arrive (drawn once a frame, however many deltas a frame brings),
 * then the block itself once the server has checked it; the proposals its tools made, each a card
 * once the stored proposal is read; and how the turn ended.
 *
 * Loaded on demand with stream.ts. `run()` sends the turn and applies its events; `stop()` flags
 * the run and drops the stream; `leave()` only drops it (the page is going). A turn that did not
 * end with a shown answer, or that proposed a change, asks the screen to read what is stored
 * (run() resolves true): the stored proposal is what its card shows.
 *
 * CoachTurns is the Coach screen's set of turns: it sends, stops and retries, opens a new
 * conversation's page as soon as the server names it, and reads the stored messages again after a
 * turn that did not end with a shown answer, so a stopped, dropped or failed turn ends on what
 * the server kept.
 */
import { goto, invalidateAll } from '$app/navigation';
import { resolve } from '$app/paths';
import { page } from '$app/state';
import type {
	ActivityState,
	AnswerBlockKind,
	CoachErrorKind,
	CoachEvent,
	CompletedBlock,
	RunStatus
} from '#lib/domain/coach/index.ts';
import { cancelRun, settleRun, streamTurn, type TurnRef, type TurnRequest } from './stream.ts';

/** A proposal the turn's tools made: its card shows once the stored proposal is read. */
export interface TurnProposal {
	id: string;
	kind: string;
	title: string;
}

export interface Chip {
	id: string;
	state: ActivityState;
	label: string;
}

/** A block still arriving: its label and its words so far, as plain text. */
export interface Draft {
	block: number;
	kind: AnswerBlockKind;
	text: string;
}

type Fetch = typeof globalThis.fetch;

export interface TurnOptions {
	/** Runs a callback before the next frame; text deltas are drawn once per frame. */
	frame?: (draw: () => void) => void;
	fetch?: Fetch;
	/** How long settleRun waits (tests shorten it). */
	settle?: Parameters<typeof settleRun>[1];
}

const nextFrame = (draw: () => void) => {
	requestAnimationFrame(draw);
};

export class CoachTurn {
	readonly request: TurnRequest;
	/** A Retry of a stored message: the conversation already shows the owner's words. */
	readonly retry: boolean;

	threadId = $state<string | null>(null);
	runId: string | null = null;
	/** The owner's stored message, from run_started. */
	ownerMessageId = $state<string | null>(null);
	/** The stored answer, from answer_completed. */
	answerMessageId = $state<string | null>(null);
	chips = $state.raw<Chip[]>([]);
	drafts = $state.raw<Draft[]>([]);
	blocks = $state.raw<CompletedBlock[]>([]);
	proposals = $state.raw<TurnProposal[]>([]);
	running = $state(true);
	error = $state<CoachErrorKind | null>(null);
	status = $state<RunStatus | null>(null);
	/** The screen has read what is stored since the turn ended. */
	settled = $state(false);
	/** A new conversation's page has opened for it. */
	opened = false;

	#frame: (draw: () => void) => void;
	#fetch: Fetch | undefined;
	#settle: TurnOptions['settle'];
	#abort = new AbortController();
	#stopping = false;
	/** Deltas since the last frame, by block. */
	#pending: Partial<Record<number, string>> = {};
	#drawing = false;

	constructor(
		request: TurnRequest,
		{ retry = false, ...options }: TurnOptions & { retry?: boolean } = {}
	) {
		this.request = request;
		this.retry = retry;
		this.threadId = request.threadId;
		this.#frame = options.frame ?? nextFrame;
		this.#fetch = options.fetch;
		this.#settle = options.settle;
	}

	/** Nothing to show yet: the coach is working out its answer. */
	get thinking(): boolean {
		return (
			this.running &&
			this.chips.length === 0 &&
			this.drafts.length === 0 &&
			this.blocks.length === 0
		);
	}

	/** The answer was completed and stored, and this turn has shown it. */
	get answered(): boolean {
		return this.answerMessageId !== null && this.blocks.length > 0;
	}

	apply(event: CoachEvent): void {
		switch (event.type) {
			case 'run_started':
				this.threadId = event.threadId;
				this.runId = event.runId;
				this.ownerMessageId = event.messageId;
				return;
			case 'activity': {
				const chip = { id: event.id, state: event.state, label: event.label };
				const at = this.chips.findIndex((each) => each.id === event.id);
				this.chips =
					at < 0 ? [...this.chips, chip] : this.chips.map((c, i) => (i === at ? chip : c));
				return;
			}
			case 'block_started':
				this.#settleDrafts();
				this.drafts = [...this.drafts, { block: event.block, kind: event.kind, text: '' }];
				return;
			case 'text_delta':
				this.#pending[event.block] = (this.#pending[event.block] ?? '') + event.text;
				if (!this.#drawing) {
					this.#drawing = true;
					this.#frame(() => this.flush());
				}
				return;
			case 'block_completed':
			case 'block_replaced': {
				const { block, kind, method, ast, sources, grounded } = event;
				const done: CompletedBlock = { block, kind, method, ast, sources, grounded };
				delete this.#pending[event.block];
				this.drafts = this.drafts.filter((draft) => draft.block !== event.block);
				const at = this.blocks.findIndex((each) => each.block === event.block);
				this.blocks =
					at < 0 ? [...this.blocks, done] : this.blocks.map((b, i) => (i === at ? done : b));
				return;
			}
			case 'answer_reset':
				this.#pending = {};
				this.drafts = [];
				this.blocks = [];
				return;
			case 'proposal':
				if (this.proposals.some((each) => each.id === event.id)) return;
				this.proposals = [
					...this.proposals,
					{ id: event.id, kind: event.kind, title: event.title }
				];
				return;
			case 'answer_completed':
				this.answerMessageId = event.messageId;
				return;
			case 'error':
				this.error = event.kind;
				return;
			case 'done':
				this.status = event.status;
				return;
		}
	}

	/** Draw the words that arrived since the last frame. */
	flush(): void {
		this.#drawing = false;
		const pending = this.#pending;
		this.#pending = {};
		if (Object.keys(pending).length === 0) return;
		this.drafts = this.drafts.map((draft) =>
			draft.block in pending ? { ...draft, text: draft.text + pending[draft.block] } : draft
		);
	}

	/** A new block starts: words still waiting for a frame join the blocks they belong to. */
	#settleDrafts() {
		this.flush();
	}

	/**
	 * Send the turn and apply its stream. Resolves true when the screen should read what is
	 * stored: the turn ended without showing a completed answer (stopped, dropped, failed) and,
	 * where it ran, it has finished on the server; or it proposed a change, whose card shows the
	 * stored proposal. `onStarted` gets the conversation's id.
	 */
	async run(onStarted?: (threadId: string) => void): Promise<boolean> {
		const end = await streamTurn(
			this.request,
			(event) => {
				this.apply(event);
				if (event.type === 'run_started') onStarted?.(event.threadId);
			},
			{ signal: this.#abort.signal, fetch: this.#fetch }
		);
		this.flush();
		if (end.kind === 'refused') this.error = end.error;
		else if (end.kind !== 'done') {
			this.error ??= this.#stopping ? 'cancelled' : 'interrupted';
			if (end.kind === 'aborted' && !this.#stopping) {
				this.running = false;
				return false; // the page was left: nothing is shown any more
			}
			await settleRun(this.runId, { fetch: this.#fetch, ...this.#settle });
		}
		this.running = false;
		return (!this.answered || this.proposals.length > 0) && end.kind !== 'refused';
	}

	/** Stop: flag the run, then drop the stream. The server stores what was shown as 'Stopped'. */
	async stop(): Promise<void> {
		if (!this.running || this.#stopping) return;
		this.#stopping = true;
		if (this.runId) await cancelRun(this.runId, this.#fetch);
		this.#abort.abort();
	}

	/** The page is going: drop the stream, and the server marks the answer interrupted. */
	leave(): void {
		this.#abort.abort();
	}
}

/** An owner message already stored, to send again (Retry). */
export interface StoredQuestion {
	clientMessageId: string;
	text: string;
}

const COACH = '/(app)/coach/[[thread]]';

/** The Coach screen's turns, newest last. */
export class CoachTurns {
	list = $state.raw<CoachTurn[]>([]);
	#options: TurnOptions;

	constructor(options: TurnOptions = {}) {
		this.#options = options;
	}

	/**
	 * The turns of the conversation on screen; on /coach, the one starting a conversation, until
	 * its page has opened.
	 */
	get visible(): CoachTurn[] {
		const here = page.params.thread ?? null;
		return this.list.filter(
			(turn) =>
				turn.threadId === here || (here === null && turn.request.threadId === null && !turn.opened)
		);
	}

	get running(): boolean {
		return this.visible.some((turn) => turn.running);
	}

	/** On /coach, a new conversation's first answer streams, before its page opens. */
	get asking(): boolean {
		return !page.params.thread && this.visible.length > 0;
	}

	/**
	 * Ask `text` in the conversation on screen, or start one on /coach (from entry `from`, when
	 * an entry point opened it). With `ref`, the turn is about it wherever it is asked: 'Ask for
	 * changes' sends the proposal it revises.
	 */
	send(text: string, from?: string | null, ref: TurnRef | null = null): Promise<void> {
		const threadId = page.params.thread ?? null;
		const entry = from && (ref || threadId === null) ? { from, ref } : null;
		return this.#start(
			new CoachTurn({ threadId, clientMessageId: crypto.randomUUID(), text, entry }, this.#options)
		);
	}

	/** Ask a stored question again: the server answers it under its own id. */
	retry(question: StoredQuestion, threadId: string): Promise<void> {
		return this.#start(new CoachTurn({ threadId, ...question }, { ...this.#options, retry: true }));
	}

	async stop(): Promise<void> {
		for (const turn of this.visible) await turn.stop();
	}

	/** The page is going: every stream is dropped, and the turns are forgotten. */
	leave(): void {
		for (const turn of this.list) turn.leave();
		this.list = [];
	}

	async #start(turn: CoachTurn): Promise<void> {
		this.list = [...this.list, turn];
		const fresh = turn.request.threadId === null;
		let opening: Promise<void> | undefined;
		const reread = await turn.run((threadId) => {
			// The conversation exists now: a reload or Back lands on it, not on an empty /coach.
			if (fresh)
				opening = goto(resolve(COACH, { thread: threadId }), { replace: true, reset: false }).then(
					() => void (turn.opened = true)
				);
		});
		// Settled first: until the stored messages arrive, the turn keeps showing what it has.
		turn.settled = true;
		if (!reread) return;
		// Its page first: until that navigation renders (WebKit holds it for a second or more while
		// it captures the view transition), invalidating would read /coach, not the conversation.
		await opening;
		await invalidateAll();
	}
}

/** The Coach screen's turns: one set, for the one screen that asks. */
export const coachTurns = new CoachTurns();
