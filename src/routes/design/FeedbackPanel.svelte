<!-- /design: feedback primitives — toasts, sheet, skeleton, empty state (loaded on demand). -->
<script lang="ts">
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import Card from '#lib/ui/components/Card.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import Skeleton from '#lib/ui/components/Skeleton.svelte';
	import Surface from '#lib/ui/components/Surface.svelte';
	import { toast } from '#lib/ui/toast.svelte.ts';

	let sheet = $state(false);
</script>

<div class="grid">
	<div class="inline">
		<Button
			variant="secondary"
			onclick={() => toast.show('Set logged · 140 kg × 5 @ 8', { tone: 'positive' })}>Toast</Button
		>
		<Button
			variant="secondary"
			onclick={() =>
				toast.show('Sync failed — will retry', {
					tone: 'danger',
					action: { label: 'Try again', onclick: () => {} }
				})}>Error toast</Button
		>
		<Button variant="secondary" onclick={() => (sheet = true)} data-testid="open-sheet"
			>Bottom sheet</Button
		>
	</div>
	<Card eyebrow="Loading" title="Skeleton">
		<div class="skeletons" aria-busy="true">
			<Skeleton circle height="2.5rem" />
			<div class="grid tight">
				<Skeleton width="60%" />
				<Skeleton width="85%" height="0.75rem" />
			</div>
		</div>
	</Card>
	<Surface padding="none" radius="xl">
		<EmptyState
			icon="pulse"
			tone="running"
			title="No runs yet"
			description="Log a run and your pace trend appears here."
			compact
		/>
	</Surface>
</div>

<BottomSheet bind:open={sheet} title="Substitute exercise" description="Same pattern, same intent.">
	<div class="grid">
		{#each ['Safety-bar squat', 'Hack squat', 'Belt squat'] as option (option)}
			<Surface padding="md" interactive>
				<div class="inline between">
					<span>{option}</span><Icon name="chevron-right" size={18} />
				</div>
			</Surface>
		{/each}
	</div>
	{#snippet footer()}
		<Button block onclick={() => (sheet = false)}>Done</Button>
	{/snippet}
</BottomSheet>

<style>
	.grid {
		display: grid;
		gap: var(--space-3);
	}

	.inline {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.tight {
		flex: 1;
		gap: var(--space-2);
	}

	.between {
		justify-content: space-between;
	}

	.skeletons {
		display: flex;
		align-items: center;
		gap: var(--space-3);
	}
</style>
