<!--
  @component
  iOS-style large title with an eyebrow line and an optional trailing action. A `badge` sits on
  the eyebrow line, beside the eyebrow, so the large title never runs into it. In Graphite 2004
  (graphite.css, the `page-header` hook) the eyebrow is hidden, and a date eyebrow (`dated`) is the
  subtitle under the title instead.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		title: string;
		eyebrow?: string;
		/** A status badge for the eyebrow line, not the title's: the title keeps its full width. */
		badge?: Snippet;
		/** The eyebrow is the date: Graphite 2004 shows it as the subtitle. */
		dated?: boolean;
		trailing?: Snippet;
	}

	let { title, eyebrow, badge, dated = false, trailing }: Props = $props();
</script>

<header class="page-header" data-ui="page-header">
	<div class="titles">
		{#if badge}
			<div class="eyebrow-row">
				{#if eyebrow}<p class="eyebrow" data-date={dated || undefined}>{eyebrow}</p>{/if}
				{@render badge()}
			</div>
		{:else if eyebrow}<p class="eyebrow" data-date={dated || undefined}>{eyebrow}</p>{/if}
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

	.eyebrow-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1-5) var(--space-2);
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
