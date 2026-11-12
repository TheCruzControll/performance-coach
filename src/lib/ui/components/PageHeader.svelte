<!--
  @component
  iOS-style large title with an eyebrow line and an optional trailing action. In Graphite 2004
  (graphite.css, the `page-header` hook) the eyebrow is hidden, and a date eyebrow (`dated`) is the
  subtitle under the title instead.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		eyebrow?: string;
		/** The eyebrow is the date: Graphite 2004 shows it as the subtitle. */
		dated?: boolean;
		trailing?: Snippet;
	}

	let { title, eyebrow, dated = false, trailing }: Props = $props();
</script>

<header class="page-header" data-ui="page-header">
	<div class="titles">
		{#if eyebrow}<p class="eyebrow" data-date={dated || undefined}>{eyebrow}</p>{/if}
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
