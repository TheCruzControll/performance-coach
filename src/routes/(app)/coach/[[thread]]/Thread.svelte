<!--
  @component
  One conversation, oldest first: the owner's messages on the right in a filled bubble, the
  coach's answers through AnswerBlocks, each labelled for screen readers, and an answer that did
  not complete marked with how it ended ('Stopped'), in words.
  An exercise source opens M4's exercise history sheet by exercise id alone, shallow-routed
  (pushState) so Back closes it; a reload shows the conversation without it. Its code is fetched
  on the first tap, so the conversation's chunk ships without it, and the thread is busy until it
  arrives. A failed fetch is the chunk-failed toast with Retry; failing again while online reloads
  the conversation asking for the sheet (`?exercise=`), which opens once its code arrives, as
  Chromium keeps a failed module fetch for the document's lifetime.
  The turns asked here (`live`, client/coach/turn.svelte.ts) follow the stored messages: the
  owner's words at once, 'Thinking…', activity chips, each block's words as they arrive, then the
  checked block. A shown answer stays as it streamed (its stored copy is not drawn twice); a turn
  that ended otherwise gives way to what the server stored, and keeps only how it ended when
  nothing was stored. An interrupted or failed last answer offers Retry, which asks the same
  question again under its own id. While an answer streams the page follows it down, unless the
  owner has scrolled up.
  A proposal shows as a card after the answer of the run that made it (a turn's, once the stored
  proposal is read). The card's code loads with the first card; a failed fetch is the chunk-failed
  notice with Retry, and failing again while online reloads the conversation. Accept goes by id;
  the card then shows the proposal as the server answered (applied as version N, or superseded).
  Reject and 'Ask for changes' open RejectSheet, loaded on the first tap: a rejection goes by id
  with its optional reason, and 'Ask for changes' asks the coach (`onask`) in a turn about the
  proposal, whose revision replaces it. A decision that failed on the way (a server failure, no
  connection) shows 'Couldn’t save' on its card, whose Retry sends the same decision again. While
  offline no card can be decided. RejectSheet failing to load is the chunk-failed notice with
  Retry; failing again while online reloads the conversation asking for the sheet
  (`?reject=<id>` or `?revise=<id>`).
-->
<script lang="ts">
	import { onMount, type Component } from 'svelte';
	import { pushState, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { decideProposal, type Decision } from '#lib/client/coach/proposals.ts';
	import type { CoachTurn, CoachTurns, StoredQuestion } from '#lib/client/coach/turn.svelte.ts';
	import type { TurnRef } from '#lib/client/coach/stream.ts';
	import type { HistoryRequest } from '#lib/client/workout/exercise-history.ts';
	import { ASK_FOR_CHANGES, type ProposalCardView } from '#lib/domain/coach/cards.ts';
	import { ANSWER_BLOCK_KIND_LABEL, COACH_ERROR_KIND_LABEL } from '#lib/domain/coach/index.ts';
	import Badge from '#lib/ui/components/Badge.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import ActivityChip from '#lib/ui/coach/ActivityChip.svelte';
	import AnswerBlocks from '#lib/ui/coach/AnswerBlocks.svelte';
	import CoachNotice from '#lib/ui/coach/CoachNotice.svelte';
	import LoadingRows from '#lib/ui/coach/LoadingRows.svelte';
	import LiveAnnouncer from '#lib/ui/coach/LiveAnnouncer.svelte';
	import ThinkingIndicator from '#lib/ui/coach/ThinkingIndicator.svelte';
	import { SCREEN_FAILURE_LABEL } from '#lib/ui/coach/coach-notices.ts';
	import { toast } from '#lib/ui/toast.svelte.ts';
	import type { ThreadView } from './coach.server';

	interface Props {
		/** None while a new conversation's first answer streams, before its page opens. */
		thread?: ThreadView;
		/** The screen's turns; null until the stream client has loaded. */
		live?: CoachTurns | null;
		/** Ask the coach in this conversation, from `from` and about `ref` ('Ask for changes'). */
		onask?: (text: string, from: string, ref: TurnRef) => void;
	}

	const NEW: ThreadView = { id: '', title: 'New conversation', messages: [] };
	let { thread = NEW, live = null, onask }: Props = $props();

	const turns = $derived(live?.visible ?? []);
	const ownerOf = (turn: CoachTurn) =>
		thread.messages.findIndex(
			(m) => m.from === 'owner' && m.clientId === turn.request.clientMessageId
		);

	/**
	 * How a turn shows: whole while it runs or once its answer is shown; after it ended otherwise,
	 * not at all when an answer to it is stored, else only how it ended.
	 */
	function modeOf(turn: CoachTurn): 'whole' | 'ended' | null {
		const at = turn.settled && !turn.answered ? ownerOf(turn) : -1;
		if (at < 0) return 'whole';
		return thread.messages[at + 1]?.from === 'coach' ? null : 'ended';
	}

	/** Stored messages a whole turn already shows: its question, its answer and its cards. */
	const hidden = $derived(
		new Set(
			turns.flatMap((turn) => {
				if (modeOf(turn) !== 'whole') return [];
				const owner = turn.retry ? undefined : thread.messages[ownerOf(turn)]?.id;
				return [
					owner,
					turn.answered ? turn.answerMessageId : null,
					...turn.proposals.map((p) => p.id)
				].filter((id) => id != null);
			})
		)
	);

	/** The last owner message or answer: the cards after it do not count. */
	const lastShown = $derived(thread.messages.findLast((m) => m.from !== 'proposal'));

	/**
	 * The question behind an interrupted or failed last answer, when it can be asked again: the
	 * last owner message (a failed Retry leaves the earlier partial before its own). Not while a
	 * turn here still shows.
	 */
	const retryable = $derived.by((): StoredQuestion | null => {
		const last = lastShown;
		const owner = thread.messages.findLast((m) => m.from === 'owner');
		const showing = turns.some((turn) => modeOf(turn));
		if (showing || last?.from !== 'coach' || !last.retryable || owner?.from !== 'owner')
			return null;
		return owner.clientId ? { clientMessageId: owner.clientId, text: owner.text } : null;
	});

	// ---- Following the answer down -----------------------------------------------------------

	let pinned = true;
	let count = 0;
	$effect(() => {
		for (const turn of turns) void [turn.chips, turn.drafts, turn.blocks, turn.running];
		if (turns.length !== count) pinned = true; // a new question: show it
		count = turns.length;
		if (pinned && turns.length) scrollTo({ top: document.documentElement.scrollHeight });
	});
	/** Near the end of the page: the answer is followed down; scrolled up, it is left alone. */
	function onscroll() {
		const { scrollTop, clientHeight, scrollHeight } = document.documentElement;
		pinned = scrollTop + clientHeight >= scrollHeight - 96;
	}

	// ---- Proposal cards ------------------------------------------------------------------------

	type CardComponent = Component<{
		card: ProposalCardView;
		onaccept?: () => void;
		onreject?: () => void;
		onrevise?: () => void;
		accepting?: boolean;
		rejecting?: boolean;
		failed?: boolean;
		onretry?: () => void;
		offline?: boolean;
	}>;

	/** Each stored card by proposal id, and what a decision here answered since. */
	const stored = $derived(
		new Map(thread.messages.flatMap((m) => (m.from === 'proposal' ? [[m.id, m.card]] : [])))
	);
	let decided = $state.raw<Record<string, ProposalCardView>>({});
	/** The decisions on their way, by proposal id. */
	let pending = $state.raw<Record<string, Decision['action']>>({});
	/** The decisions that failed on the way and may go through if sent again, by proposal id. */
	let failures = $state.raw<Record<string, Decision>>({});
	const cardFor = (id: string): ProposalCardView | undefined => decided[id] ?? stored.get(id);
	const without = <T,>(record: Record<string, T>, id: string) =>
		Object.fromEntries(Object.entries(record).filter(([key]) => key !== id));

	let online = $state(true);

	/** Send a decision by id; Retry sends the same one again, which the server never applies twice. */
	async function decide(id: string, decision: Decision) {
		if (pending[id]) return; // a second tap while the first is on its way
		pending = { ...pending, [id]: decision.action };
		failures = without(failures, id);
		const result = await decideProposal(id, decision);
		pending = without(pending, id);
		if (result.kind === 'decided') decided = { ...decided, [id]: result.card };
		else if (result.retry) failures = { ...failures, [id]: decision };
		else toast.show(SCREEN_FAILURE_LABEL.action_failed, { tone: 'danger' });
	}

	// ---- Reject and 'Ask for changes' ----------------------------------------------------------

	type DecisionSheet = Component<{
		open: boolean;
		mode: 'reject' | 'revise';
		title: string;
		pending?: boolean;
		onsubmit: (words: string | null) => void;
		onclose?: () => void;
	}>;
	type SheetMode = 'reject' | 'revise';

	let DecisionSheetCode = $state.raw<DecisionSheet | null>(null);
	let sheetFor = $state.raw<{ id: string; mode: SheetMode } | null>(null);
	let sheetOpen = $state(false);
	/** The card whose sheet failed to load, offered again by Retry. */
	let sheetFailed = $state.raw<{ id: string; mode: SheetMode } | null>(null);
	let sheetFailures = 0;
	let sheetLoading = false;
	const loadDecisionSheet = (): Promise<{ default: DecisionSheet }> =>
		import.meta.env.SSR
			? Promise.reject(new Error('client only'))
			: import('#lib/ui/coach/RejectSheet.svelte');

	function openSheet(id: string, mode: SheetMode) {
		if (sheetLoading) return;
		sheetFailed = null;
		if (DecisionSheetCode) {
			sheetFor = { id, mode };
			sheetOpen = true;
			return;
		}
		sheetLoading = true;
		loadDecisionSheet().then(
			(module) => {
				sheetLoading = false;
				DecisionSheetCode = module.default;
				sheetFor = { id, mode };
				sheetOpen = true;
			},
			() => {
				sheetLoading = false;
				// Chromium keeps a failed module fetch for the document's lifetime: start again.
				if (++sheetFailures >= 2 && navigator.onLine)
					return location.replace(`?${mode}=${encodeURIComponent(id)}`);
				sheetFailed = { id, mode };
			}
		);
	}

	async function submitSheet(words: string | null) {
		const target = sheetFor;
		const card = target && cardFor(target.id);
		if (!target || !card) return;
		if (target.mode === 'revise') {
			sheetOpen = false;
			if (words)
				onask?.(words, ASK_FOR_CHANGES, { type: 'proposal', id: card.id, label: card.title });
			return;
		}
		await decide(target.id, { action: 'reject', reason: words });
		sheetOpen = false;
	}

	let Card = $state.raw<CardComponent | null>(null);
	let cardFailed = $state(false);
	let cardLoading = false;
	let cardFailures = 0;
	const loadCard = (): Promise<{ default: CardComponent }> =>
		import.meta.env.SSR
			? Promise.reject(new Error('client only'))
			: import('#lib/ui/coach/ProposalCard.svelte');

	function fetchCard() {
		if (Card || cardLoading) return;
		cardLoading = true;
		cardFailed = false;
		loadCard().then(
			(module) => {
				cardLoading = false;
				Card = module.default;
			},
			() => {
				cardLoading = false;
				// Chromium keeps a failed module fetch for the document's lifetime: start again.
				if (++cardFailures >= 2 && navigator.onLine) return location.reload();
				cardFailed = true;
			}
		);
	}

	const wantsCards = $derived(
		stored.size > 0 || turns.some((turn) => modeOf(turn) === 'whole' && turn.proposals.length)
	);
	$effect(() => {
		if (wantsCards) fetchCard();
	});

	type HistorySheet = Component<{ request: HistoryRequest | null; onclose?: () => void }>;

	/** The query a reload asks for an exercise's sheet with, after its code failed twice. */
	const REOPEN = 'exercise';

	let Sheet = $state.raw<HistorySheet | null>(null);
	let opening = $state(false);
	let failed = false;

	// Left out of the server build, which never renders it (UsageButton.svelte), and kept apart
	// from .then(): Vite moves `import(…).then(…)` whole into its preloader.
	const loadSheet = (): Promise<{ default: HistorySheet }> =>
		import.meta.env.SSR
			? Promise.reject(new Error('client only'))
			: import('#lib/ui/workout/ExerciseHistorySheet.svelte');

	function openExercise(exerciseId: string) {
		if (opening) return; // a second tap while its code is on the way
		opening = true;
		loadSheet().then(
			(module) => {
				opening = false;
				Sheet = module.default;
				void pushState('', { coachExercise: { exerciseId } });
			},
			() => {
				opening = false;
				if (failed && navigator.onLine)
					return location.replace(`?${REOPEN}=${encodeURIComponent(exerciseId)}`);
				failed = true;
				toast.show(SCREEN_FAILURE_LABEL.chunk_failed, {
					tone: 'danger',
					duration: 0,
					action: { label: 'Retry', onclick: () => openExercise(exerciseId) }
				});
			}
		);
	}

	/** WebKit does not focus a clicked button: focus the source, so closing the sheet returns here. */
	function focusSource(event: MouseEvent) {
		(event.target as Element).closest<HTMLElement>('[aria-label="Sources"] button')?.focus();
	}

	onMount(async () => {
		online = navigator.onLine;
		const asked = page.url.searchParams.get(REOPEN);
		const reject = page.url.searchParams.get('reject');
		const revise = page.url.searchParams.get('revise');
		// A reload keeps an open sheet's state in its history entry, though not in page.state:
		// Back from the next sheet would bring it back. Clear it, and the reload's question.
		if (thread.id && !page.state.coachExercise)
			await replaceState(resolve('/(app)/coach/[[thread]]', { thread: thread.id }), {});
		if (asked) openExercise(asked);
		if (reject ?? revise) openSheet((reject ?? revise)!, reject ? 'reject' : 'revise');
	});
</script>

<svelte:window {onscroll} ononline={() => (online = true)} onoffline={() => (online = false)} />

{#snippet proposal(id: string, title: string)}
	{@const card = cardFor(id)}
	{#if Card && card}
		<Card
			{card}
			accepting={pending[id] === 'accept'}
			rejecting={pending[id] === 'reject'}
			failed={id in failures}
			offline={!online}
			onaccept={() => decide(id, { action: 'accept' })}
			onreject={() => openSheet(id, 'reject')}
			onrevise={onask && !live?.running ? () => openSheet(id, 'revise') : undefined}
			onretry={() => failures[id] && decide(id, failures[id])}
		/>
		{#if sheetFailed?.id === id}
			<CoachNotice
				kind="chunk_failed"
				onretry={() => openSheet(id, sheetFailed!.mode)}
				data-testid="decision-sheet-failed"
			/>
		{/if}
	{:else if cardFailed}
		<CoachNotice kind="chunk_failed" onretry={fetchCard} data-testid="proposal-failed" />
	{:else}
		<LoadingRows label="Loading the proposal “{title}”…" rows={2} data-testid="proposal-loading" />
	{/if}
{/snippet}

{#snippet ended(label: string, question: StoredQuestion | null, threadId = thread.id)}
	<p class="ended">
		<Badge tone="warning" icon="alert" data-testid="answer-ended">{label}</Badge>
		{#if question && live}
			<Button variant="secondary" size="sm" onclick={() => live.retry(question, threadId)}
				>Retry</Button
			>
		{/if}
	</p>
{/snippet}

<article
	class="thread"
	aria-labelledby="thread-title"
	aria-busy={opening ? 'true' : undefined}
	onclickcapture={focusSource}
	data-testid="thread"
>
	<h2 id="thread-title" class="title">{thread.title}</h2>
	<ol class="messages">
		{#each thread.messages as message (message.id)}
			{#if hidden.has(message.id)}
				<!-- shown by its turn below -->
			{:else if message.from === 'proposal'}
				<li class="coach" data-testid="proposal">
					{@render proposal(message.id, message.card.title)}
				</li>
			{:else if message.from === 'owner'}
				<li class="owner" data-testid="owner-message">
					<span class="visually-hidden">You:</span>
					<p class="bubble">{message.text}</p>
				</li>
			{:else}
				<li class="coach" data-testid="coach-message">
					<span class="visually-hidden">Coach:</span>
					<AnswerBlocks blocks={message.blocks} onopenexercise={openExercise} />
					{#if message.ended}
						{@render ended(message.ended, message === lastShown ? retryable : null)}
					{/if}
				</li>
			{/if}
		{/each}
		{#each turns as turn (turn)}
			{@const mode = modeOf(turn)}
			{@const end = turn.settled && !turn.answered && turn.error}
			{#if mode === 'whole' && !turn.retry}
				<li class="owner" data-testid="owner-message">
					<span class="visually-hidden">You:</span>
					<p class="bubble">{turn.request.text}</p>
				</li>
			{/if}
			{#if mode}
				<li
					class="coach"
					aria-busy={turn.settled ? undefined : 'true'}
					data-testid={mode === 'whole' ? 'live-answer' : 'live-ended'}
				>
					<span class="visually-hidden">Coach:</span>
					{#if mode === 'whole'}
						{#if turn.chips.length}
							<ul class="chips" aria-label="What the coach did">
								{#each turn.chips as chip (chip.id)}
									<li>
										<ActivityChip state={chip.state} label={chip.label} data-testid="activity" />
									</li>
								{/each}
							</ul>
						{/if}
						{#if turn.thinking}<ThinkingIndicator data-testid="thinking" />{/if}
						{#if turn.blocks.length}
							<AnswerBlocks blocks={turn.blocks} onopenexercise={openExercise} />
						{/if}
						{#each turn.drafts as draft (draft.block)}
							<div class="draft" data-testid="answer-draft">
								<span class="kind">{ANSWER_BLOCK_KIND_LABEL[draft.kind]}</span>
								<p>{draft.text}</p>
							</div>
						{/each}
						<LiveAnnouncer blocks={turn.blocks} complete={turn.answered} />
						{#each turn.proposals as each (each.id)}
							<div data-testid="proposal">{@render proposal(each.id, each.title)}</div>
						{/each}
					{/if}
					{#if end}
						{@render ended(
							COACH_ERROR_KIND_LABEL[end],
							turn === turns.at(-1) &&
								turn.threadId &&
								(end === 'interrupted' || end === 'provider' || end === 'timeout')
								? { clientMessageId: turn.request.clientMessageId, text: turn.request.text }
								: null,
							turn.threadId ?? undefined
						)}
					{/if}
				</li>
			{/if}
		{/each}
	</ol>
	<p class="visually-hidden" role="status">{opening ? 'Opening its history…' : ''}</p>
</article>

{#if Sheet}
	<Sheet request={page.state.coachExercise ?? null} onclose={() => history.back()} />
{/if}

{#if DecisionSheetCode && sheetFor}
	<DecisionSheetCode
		bind:open={sheetOpen}
		mode={sheetFor.mode}
		title={cardFor(sheetFor.id)?.title ?? ''}
		pending={pending[sheetFor.id] === 'reject'}
		onsubmit={submitSheet}
	/>
{/if}

<style>
	.thread {
		display: grid;
		gap: var(--space-4);
	}

	/* The sheet's code on its way after a tap. */
	.thread[aria-busy='true'] {
		cursor: progress;
	}

	.title {
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
		line-height: var(--leading-snug);
		overflow-wrap: anywhere;
	}

	.messages {
		display: grid;
		gap: var(--space-5);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.owner {
		display: flex;
		justify-content: flex-end;
	}

	.bubble {
		max-width: 85%;
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-xl) var(--radius-xl) var(--radius-sm) var(--radius-xl);
		background: var(--color-surface-2);
		border: 1px solid var(--color-border);
		color: var(--color-text);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.coach {
		display: grid;
		gap: var(--space-2);
	}

	.ended {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		justify-self: start;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1-5);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	/* A block still arriving: its label and its words so far, edged like a finished note. */
	.draft {
		display: grid;
		gap: var(--space-2);
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		border-left: 3px solid var(--color-border-strong);
		background: var(--color-surface-1);
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.kind {
		color: var(--color-text-secondary);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
	}
</style>
