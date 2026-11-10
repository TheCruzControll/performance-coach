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
-->
<script lang="ts">
	import { onMount, type Component } from 'svelte';
	import { pushState, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import type { CoachTurn, CoachTurns, StoredQuestion } from '#lib/client/coach/turn.svelte.ts';
	import type { HistoryRequest } from '#lib/client/workout/exercise-history.ts';
	import { ANSWER_BLOCK_KIND_LABEL, COACH_ERROR_KIND_LABEL } from '#lib/domain/coach/index.ts';
	import Badge from '#lib/ui/components/Badge.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import ActivityChip from '#lib/ui/coach/ActivityChip.svelte';
	import AnswerBlocks from '#lib/ui/coach/AnswerBlocks.svelte';
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
	}

	const NEW: ThreadView = { id: '', title: 'New conversation', messages: [] };
	let { thread = NEW, live = null }: Props = $props();

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

	/** Stored messages a whole turn already shows. */
	const hidden = $derived(
		new Set(
			turns.flatMap((turn) => {
				if (modeOf(turn) !== 'whole') return [];
				const owner = turn.retry ? undefined : thread.messages[ownerOf(turn)]?.id;
				return [owner, turn.answered ? turn.answerMessageId : null].filter((id) => id != null);
			})
		)
	);

	/**
	 * The question behind an interrupted or failed last answer, when it can be asked again: the
	 * last owner message (a failed Retry leaves the earlier partial before its own). Not while a
	 * turn here still shows.
	 */
	const retryable = $derived.by((): StoredQuestion | null => {
		const last = thread.messages.at(-1);
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
		const asked = page.url.searchParams.get(REOPEN);
		// A reload keeps an open sheet's state in its history entry, though not in page.state:
		// Back from the next sheet would bring it back. Clear it, and the reload's question.
		if (thread.id && !page.state.coachExercise)
			await replaceState(resolve('/(app)/coach/[[thread]]', { thread: thread.id }), {});
		if (asked) openExercise(asked);
	});
</script>

<svelte:window {onscroll} />

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
						{@render ended(message.ended, message === thread.messages.at(-1) ? retryable : null)}
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
