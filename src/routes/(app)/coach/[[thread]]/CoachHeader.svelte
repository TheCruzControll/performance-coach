<!--
  @component
  The Coach screens' header: the large title, the practice coach's badge while the mock answers
  (words, never colour alone) on the eyebrow line, where the title cannot run into it, and the
  header's actions, each a slot one slice fills: the proposals inbox, 'What it knows' and
  'Usage', the icon buttons named and, for a mouse, captioned with those words.
-->
<script lang="ts">
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import MockBadge from '#lib/ui/coach/MockBadge.svelte';
	import KnowsButton from './KnowsButton.svelte';
	import ProposalsLink from './ProposalsLink.svelte';
	import UsageButton from './UsageButton.svelte';

	let { mockBadge }: { mockBadge: boolean } = $props();
</script>

{#snippet practice()}<MockBadge data-testid="mock-badge" />{/snippet}

<PageHeader title="Coach" eyebrow="Ask anything" badge={mockBadge ? practice : undefined}>
	{#snippet trailing()}
		<div class="actions">
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
