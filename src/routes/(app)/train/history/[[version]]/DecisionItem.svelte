<!--
  @component
  One decision in History: what it decided, in a line (left out when its version already says
  it, as an edit's one decision does), then why, in the coach's or the owner's own words. A
  list item: the caller renders the list.
-->
<script lang="ts">
	import type { DecisionItemView } from './history.server';

	let { decision }: { decision: DecisionItemView } = $props();
</script>

<li class="decision" data-testid="decision">
	{#if decision.summary}<p class="summary">{decision.summary}</p>{/if}
	<p class="why">{decision.why}</p>
</li>

<style>
	/* A quiet dot on the reasons' rail, centred on the first line. */
	.decision {
		position: relative;
		display: grid;
		gap: var(--space-0-5);
		padding-left: var(--space-4);
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
	}

	.decision::before {
		content: '';
		position: absolute;
		top: 0.5625rem;
		left: 0;
		width: 0.375rem;
		height: 0.375rem;
		border-radius: var(--radius-full);
		background: var(--color-text-tertiary);
	}

	.summary {
		font-weight: var(--weight-semibold);
		color: var(--color-text);
	}

	.why {
		color: var(--color-text-secondary);
	}
</style>
