<!--
  @component
  A review prompt (review-prompt.ts, composed on the server): 'Your week in review is ready' or
  'Block complete — review it and plan the next', with a Create review button that creates and
  opens it, or 'See your review' once it exists. Today's Program panel and Progress's Overview put
  it at the top. Create posts the reviews screen's own action, a form that works without
  JavaScript too, with the review list's states:

  - pending: aria-busy and disabled, so a second tap posts nothing (the service is idempotent
    under the owner lock as well)
  - not reviewable yet (409): when it will be, and why
  - failure (500, or the request never answered): a notice, and the button resends as Try again
  - offline: disabled, with 'You're offline'

  An EmptyState in an accent frame. The frame and the state lines are styled inline, not in a
  stylesheet of its own: /progress links every view's CSS and sits at its 14 KB allowance, and a
  separate file costs ~0.24 KB gzip on it and on Today (docs/performance.md).
-->
<script lang="ts">
	import { applyAction, enhance, type SubmitFunction } from '$app/forms';
	import { onMount } from 'svelte';
	import Button from '../components/Button.svelte';
	import EmptyState from '../components/EmptyState.svelte';
	import Icon from '../components/Icon.svelte';
	import type { ReviewPromptView } from './review-prompt';

	let { review }: { review: ReviewPromptView } = $props();

	/** navigator.onLine and its events, as the review list reads them (ReviewList.svelte). */
	let online = $state(true);
	onMount(() => (online = navigator.onLine));

	const FRAME =
		'border:1px solid var(--color-accent);border-radius:var(--radius-xl);background:var(--color-surface-1)';
	/** A state's line, under the button: centred, small, quiet. */
	const NOTE =
		'display:flex;flex-basis:100%;justify-content:center;gap:var(--space-1-5);font-size:var(--text-sm);color:var(--color-text-secondary)';

	let status = $state<'pending' | 'failed' | { ready?: string }>();

	const submit: SubmitFunction = ({ cancel }) => {
		if (status === 'pending' || !online) return cancel();
		status = 'pending';
		return async ({ result }) => {
			if (result.type === 'failure' && result.data?.reason === 'not_reviewable')
				status = { ready: result.data.ready };
			else if (result.type === 'redirect') {
				await applyAction(result);
				status = undefined;
			} else status = 'failed';
		};
	};
</script>

<svelte:window ononline={() => (online = true)} onoffline={() => (online = false)} />

<div style={FRAME} data-testid="review-prompt" data-kind={review.kind} data-state={review.state}>
	<EmptyState
		compact
		icon={review.kind === 'cycle' ? 'check' : 'sparkle'}
		title={review.title}
		description={review.summary}
	>
		{#snippet actions()}
			{#if review.href}
				<Button href={review.href} variant="secondary" iconEnd="arrow-right">See your review</Button
				>
			{:else if review.create}
				<form method="POST" action={review.create.action} use:enhance={submit}>
					{#each Object.entries(review.create.fields) as [name, value] (name)}
						<input type="hidden" {name} {value} />
					{/each}
					<Button
						type="submit"
						icon={status === 'failed' ? 'refresh' : undefined}
						loading={status === 'pending'}
						disabled={!online}>{status === 'failed' ? 'Try again' : 'Create review'}</Button
					>
				</form>
				{#if !online}
					<p style={NOTE} role="status" data-testid="create-offline">
						<Icon name="wifi-off" size={16} />You’re offline
					</p>
				{:else if typeof status === 'object'}
					<p style={NOTE} role="status" data-testid="create-refused">
						<Icon name="clock" size={16} />{review.notReady}{status.ready
							? ` · ${status.ready}`
							: ''}
					</p>
				{:else if status === 'failed'}
					<p style="{NOTE};color:var(--color-danger)" role="alert" data-testid="create-failed">
						<Icon name="alert" size={16} />Couldn’t create this review. Your training is safe: try
						again.
					</p>
				{/if}
			{/if}
		{/snippet}
	</EmptyState>
</div>
