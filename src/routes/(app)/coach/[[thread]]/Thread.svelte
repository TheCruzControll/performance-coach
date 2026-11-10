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
-->
<script lang="ts">
	import { onMount, type Component } from 'svelte';
	import { pushState, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import type { HistoryRequest } from '#lib/client/workout/exercise-history.ts';
	import Badge from '#lib/ui/components/Badge.svelte';
	import AnswerBlocks from '#lib/ui/coach/AnswerBlocks.svelte';
	import { SCREEN_FAILURE_LABEL } from '#lib/ui/coach/coach-notices.ts';
	import { toast } from '#lib/ui/toast.svelte.ts';
	import type { ThreadView } from './coach.server';

	let { thread }: { thread: ThreadView } = $props();

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
		if (!page.state.coachExercise)
			await replaceState(resolve('/(app)/coach/[[thread]]', { thread: thread.id }), {});
		if (asked) openExercise(asked);
	});
</script>

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
			{#if message.from === 'owner'}
				<li class="owner" data-testid="owner-message">
					<span class="visually-hidden">You:</span>
					<p class="bubble">{message.text}</p>
				</li>
			{:else}
				<li class="coach" data-testid="coach-message">
					<span class="visually-hidden">Coach:</span>
					<AnswerBlocks blocks={message.blocks} onopenexercise={openExercise} />
					{#if message.ended}
						<p class="ended">
							<Badge tone="warning" icon="alert" data-testid="answer-ended">{message.ended}</Badge>
						</p>
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
		justify-self: start;
	}
</style>
