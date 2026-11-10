<!--
  @component
  Where a prefilled question came from ('From your workout'), above the conversation it starts:
  an icon and words in a quiet pill.
-->
<script lang="ts">
	import Icon from '#lib/ui/components/Icon.svelte';

	let { label }: { label: string } = $props();
</script>

<p class="chip" data-testid="context-chip">
	<Icon name="arrow-right" size={14} strokeWidth={2} />
	<span class="visually-hidden">Asking about:</span>
	{label}
</p>

<style>
	.chip {
		display: inline-flex;
		align-items: center;
		justify-self: start;
		gap: var(--space-1-5);
		min-height: 1.75rem;
		padding: 0 var(--space-3);
		border-radius: var(--radius-full);
		border: 1px solid var(--color-border);
		background: var(--color-surface-1);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
	}
</style>
