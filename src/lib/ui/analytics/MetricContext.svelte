<!--
  @component
  The context under a metric or a group of tiles, in one line: the period, what it is compared
  with, the trend's window when it differs from the period, and what counts as good; then a
  <details> with how the figure is worked out (and its caveat, when it has one). The server sends
  the words (the metric catalogue's `good.words`, `method` and `caveat`), so a tile, a review and
  the coach describe a number the same way.
-->
<script lang="ts">
	import Icon from '../components/Icon.svelte';

	interface Props {
		/** 'Last 12 weeks'. */
		period: string;
		/** 'Compared with the 12 weeks before'; null when there is no earlier period ('All time'). */
		comparison: string | null;
		/** 'Trend over the last 12 weeks', given only when the verdict reads other weeks. */
		trend?: string | null;
		/** What counts as good: 'Good is a real rise over the trend window'. */
		good: string;
		method: string;
		caveat?: string | null;
		'data-testid'?: string;
	}

	let { period, comparison, trend = null, good, method, caveat = null, ...rest }: Props = $props();

	const parts = $derived([period, comparison, trend, good].filter((part) => part !== null));
</script>

<div class="context" {...rest}>
	<p class="line" data-testid="context-line">{parts.join(' · ')}</p>
	<details class="method">
		<summary><Icon name="chevron-right" size={16} strokeWidth={2} />How it’s worked out</summary>
		<p>{method}</p>
		{#if caveat}<p class="caveat">{caveat}</p>{/if}
	</details>
</div>

<style>
	.context {
		display: grid;
		gap: var(--space-1);
		min-width: 0;
	}

	.line {
		font-size: var(--text-xs);
		line-height: var(--leading-normal);
		color: var(--color-text-secondary);
	}

	summary {
		display: flex;
		align-items: center;
		gap: var(--space-1-5);
		min-height: var(--touch-target);
		width: fit-content;
		padding: 0 var(--space-2);
		margin-inline: calc(var(--space-2) * -1);
		border-radius: var(--radius-sm);
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		cursor: pointer;
		list-style: none;
	}

	summary::-webkit-details-marker {
		display: none;
	}

	summary :global(.icon) {
		transition: transform var(--duration-fast) var(--ease-standard);
	}

	.method[open] summary :global(.icon) {
		transform: rotate(90deg);
	}

	summary:active {
		background: var(--color-surface-2);
	}

	@media (hover: hover) and (pointer: fine) {
		summary:hover {
			background: var(--color-surface-2);
			color: var(--color-text);
		}
	}

	.method p {
		max-width: 60ch;
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
		color: var(--color-text-secondary);
	}

	.method .caveat {
		margin-top: var(--space-2);
		color: var(--color-text-tertiary);
	}
</style>
