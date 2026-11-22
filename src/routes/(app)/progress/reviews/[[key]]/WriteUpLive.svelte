<!--
  @component
  The write-up's live part (review-narrative-ui), loaded after hydration by CoachWriteUp in place
  of the frame the server rendered, with the same layout, so none of it is initial JS:

  - a box reserved at six lines, so nothing shifts when the write-up arrives; 'Read all' opens it
    when it holds more
  - written: M5's AnswerBlocks draw the run's display blocks over the stored released text,
    loaded on demand (write-up-client.ts)
  - being written: 'Your coach is writing this up…', requested once on idle or polled when another
    request runs it
  - no write-up: why (not launched, switched off, budget, rate limited, offline, failed), with
    Retry where asking again can help
  - 'Discuss with your coach': a new conversation about this review
-->
<script lang="ts">
	import { onMount, type Component } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { CompletedBlock } from '#lib/domain/coach/events.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import type { Narration } from './load';
	import { WRITING, type NarrationView } from './write-up';
	import { answerBlocks, follow, request } from './write-up-client';

	let { narration }: { narration: Narration } = $props();
	// svelte-ignore state_referenced_locally
	let view = $state(narration.view);
	let Blocks = $state<
		Component<{
			blocks: readonly CompletedBlock[];
			onopenexercise?: (exerciseId: string) => void;
		}>
	>();
	const openExercise = (id: string) => goto(resolve('/(app)/progress/exercises/[id]', { id }));
	let box = $state<HTMLElement>();
	let open = $state(false);
	let more = $state(false);
	const stop = new AbortController();
	const io = { set: (next: NarrationView) => (view = next), signal: stop.signal };

	onMount(() => {
		follow(narration.target, view, io);
		return () => stop.abort();
	});

	$effect(() => {
		if (view.state === 'written' && !Blocks)
			answerBlocks().then((loaded) => (Blocks = loaded.default));
	});

	$effect(() => {
		void [view, Blocks];
		more = !!box && box.scrollHeight > box.clientHeight + 1;
	});
</script>

<section
	class="write-up"
	aria-labelledby="write-up-title"
	data-testid="review-write-up"
	data-state={view.state}
>
	<h3 id="write-up-title">Your coach’s write-up</h3>
	<div
		class="box"
		class:open
		bind:this={box}
		aria-live="polite"
		aria-busy={view.state === 'writing'}
	>
		{#if view.state === 'written'}
			{#if Blocks && view.blocks.length > 0}
				<Blocks blocks={view.blocks} onopenexercise={openExercise} />
			{:else}
				{#each view.text.split('\n\n') as line, i (i)}<p>{line}</p>{/each}
			{/if}
		{:else if view.state === 'writing'}
			<p class="quiet">{WRITING}</p>
		{:else}
			<p data-testid="write-up-notice"><strong>{view.title}</strong> {view.detail}</p>
		{/if}
	</div>
	<div class="actions">
		{#if more && !open}
			<Button variant="ghost" size="sm" icon="chevron-down" onclick={() => (open = true)}
				>Read all</Button
			>
		{/if}
		{#if view.state === 'notice' && view.action}
			<Button
				variant="secondary"
				size="sm"
				icon="refresh"
				onclick={() => request(narration.target, io)}
				data-testid="write-up-retry">{view.action}</Button
			>
		{/if}
		<Button
			variant="secondary"
			size="sm"
			icon="coach"
			href={narration.discuss}
			data-testid="review-discuss">Discuss with your coach</Button
		>
	</div>
</section>

<style>
	.write-up {
		display: grid;
		gap: var(--space-3);
		padding: var(--space-4);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
	}

	h3 {
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
	}

	.box {
		display: grid;
		gap: var(--space-2);
		align-content: start;
		height: calc(6em * var(--leading-normal));
		overflow: hidden;
	}

	.open {
		height: auto;
	}

	.quiet {
		color: var(--color-text-secondary);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
</style>
