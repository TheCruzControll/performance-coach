<!--
  @component
  The Coach screens' header: the large title, the practice coach's badge while the mock answers
  (words, never colour alone), and the header's actions, each a slot one slice fills: the
  proposals inbox, 'What the coach knows' and usage.
-->
<script lang="ts">
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import MockBadge from '#lib/ui/coach/MockBadge.svelte';
	import KnowsButton from './KnowsButton.svelte';
	import ProposalsLink from './ProposalsLink.svelte';
	import UsageButton from './UsageButton.svelte';

	let { mockBadge }: { mockBadge: boolean } = $props();
</script>

<PageHeader title="Coach" eyebrow="Ask anything">
	{#snippet trailing()}
		<div class="actions">
			{#if mockBadge}<MockBadge data-testid="mock-badge" />{/if}
			<ProposalsLink />
			<KnowsButton />
			<UsageButton />
		</div>
	{/snippet}
</PageHeader>

<style>
	.actions {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}
</style>
