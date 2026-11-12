<!--
  @component
  Starting a workout while another is in progress on this device (StartFlow.svelte, loaded only
  then): Resume it, or Discard it and start the new one. What Discard does is said first: the
  workout is kept in History as abandoned, synced or not, since its start may have reached the
  server; only one whose start the server refused is deleted from this device with what was logged
  in it. A BottomSheet: a centred dialog from 1024 px, Escape closes it and focus returns. Both
  actions are primitive Buttons (44 px, hover and :focus-visible states).
-->
<script lang="ts">
	import type { InProgress } from '#lib/client/workout/start.ts';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import Button from '#lib/ui/components/Button.svelte';

	interface Props {
		open: boolean;
		active: InProgress;
		/** Discarding: its button spins and neither action can be pressed again. */
		busy: boolean;
		onresume: () => void;
		ondiscard: () => void;
	}

	let { open = $bindable(), active, busy, onresume, ondiscard }: Props = $props();

	const started = $derived(
		active.startedAt
			? `Started at ${new Date(active.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
			: undefined
	);
</script>

<BottomSheet
	bind:open
	title={`${active.title} is in progress`}
	description={started}
	data-testid="start-conflict-sheet"
>
	<p class="consequence" data-testid="start-conflict-consequence">
		{active.startParked === 'refused'
			? 'The server refused it, so discarding deletes it from this device, with everything logged in it.'
			: 'Discarding keeps it in your history as abandoned, with everything you logged.'}
	</p>
	{#snippet footer()}
		<div class="actions">
			<Button
				block
				iconEnd="arrow-right"
				disabled={busy}
				onclick={onresume}
				data-testid="start-resume">Resume {active.title}</Button
			>
			<Button
				block
				variant="danger"
				icon="trash"
				loading={busy}
				onclick={ondiscard}
				data-testid="start-discard">Discard and start this one</Button
			>
		</div>
	{/snippet}
</BottomSheet>

<style>
	.consequence {
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
		color: var(--color-text-secondary);
	}

	.actions {
		display: grid;
		gap: var(--space-2);
	}
</style>
