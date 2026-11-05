<!--
  @component
  iOS-style large title with an eyebrow line and an optional trailing action.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		eyebrow?: string;
		trailing?: Snippet;
	}

	let { title, eyebrow, trailing }: Props = $props();
</script>

<header class="page-header">
	<div class="titles">
		{#if eyebrow}<p class="eyebrow">{eyebrow}</p>{/if}
		<h1 class="title">{title}</h1>
	</div>
	{#if trailing}<div class="trailing">{@render trailing()}</div>{/if}
</header>

<style>
	.page-header {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: var(--space-4);
		padding: var(--space-6) 0 var(--space-5);
	}

	.titles {
		display: grid;
		gap: var(--space-1-5);
		min-width: 0;
	}

	.title {
		font-family: var(--font-display);
		font-size: var(--text-3xl);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-display);
		line-height: var(--leading-tight);
	}

	.trailing {
		flex: none;
		margin-bottom: calc(var(--space-1) * -1);
	}
</style>
