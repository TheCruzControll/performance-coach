<!--
  @component
  One conversation, oldest first: the owner's messages on the right in a filled bubble, the
  coach's answers through AnswerBlocks, each labelled for screen readers, and an answer that did
  not complete marked with how it ended ('Stopped'), in words.
-->
<script lang="ts">
	import Badge from '#lib/ui/components/Badge.svelte';
	import AnswerBlocks from '#lib/ui/coach/AnswerBlocks.svelte';
	import type { ThreadView } from './coach.server';

	let { thread }: { thread: ThreadView } = $props();
</script>

<article class="thread" aria-labelledby="thread-title" data-testid="thread">
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
					<AnswerBlocks blocks={message.blocks} />
					{#if message.ended}
						<p class="ended">
							<Badge tone="warning" icon="alert" data-testid="answer-ended">{message.ended}</Badge>
						</p>
					{/if}
				</li>
			{/if}
		{/each}
	</ol>
</article>

<style>
	.thread {
		display: grid;
		gap: var(--space-4);
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
