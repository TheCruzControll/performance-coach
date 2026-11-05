<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import Button from '#lib/ui/components/Button.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';

	const notFound = $derived(page.status === 404);
</script>

<svelte:head>
	<title>{notFound ? 'Not found' : 'Error'} · Performance Coach</title>
</svelte:head>

<main id="main" class="error-page">
	<p class="code numeric" aria-hidden="true">{page.status}</p>
	<EmptyState
		icon={notFound ? 'target' : 'alert'}
		tone={notFound ? 'neutral' : 'combat'}
		title={notFound ? 'Nothing here' : 'Something went wrong'}
		description={notFound
			? 'This page does not exist. Your training data is safe.'
			: (page.error?.message ?? 'An unexpected error occurred.')}
	>
		{#snippet actions()}
			<Button href={resolve('/(app)/today')} icon="today">Back to Today</Button>
		{/snippet}
	</EmptyState>
	{#if page.error?.requestId}
		<p class="ref">Reference <code>{page.error.requestId}</code></p>
	{/if}
</main>

<style>
	.error-page {
		display: grid;
		place-content: center;
		justify-items: center;
		gap: var(--space-2);
		min-height: 100dvh;
		padding: calc(var(--safe-top) + var(--space-8)) var(--gutter)
			calc(var(--safe-bottom) + var(--space-8));
		text-align: center;
	}

	.code {
		font-size: var(--text-6xl);
		font-weight: var(--weight-black);
		line-height: 1;
		color: var(--color-text-disabled);
	}

	.ref {
		font-size: var(--text-xs);
		color: var(--color-text-tertiary);
	}

	code {
		font-variant-numeric: tabular-nums;
	}
</style>
