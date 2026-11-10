<!--
  @component
  The workout menu: the header's More button (an IconButton, 44 px, with hover and :focus-visible
  states; the Shell loads it on idle with the store, its place kept meanwhile) and its sheet:
  Finish workout, which opens the finish sheet, and Discard workout, which asks first and says
  what it does. A
  workout that has not synced is deleted from this device with everything logged in it; one the
  server holds is kept there as abandoned (start.ts's discardInProgress, the start conflict's
  Discard). A BottomSheet: a centred dialog from 1024 px, Escape closes it and focus returns.
  Every action is a primitive Button (44 px, hover and :focus-visible states).
-->
<script lang="ts">
	import type { InProgress } from '#lib/client/workout/start.ts';
	import type { WorkoutStore } from '#lib/client/workout/store.ts';
	import type { WorkoutView } from '#lib/domain/workout/index.ts';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import IconButton from '#lib/ui/components/IconButton.svelte';
	import { tick } from 'svelte';

	interface Props {
		view: WorkoutView;
		store: WorkoutStore;
		onfinish: () => void;
	}

	let { view, store, onfinish }: Props = $props();

	let open = $state(false);

	/** The workout as Discard's question shows it, once asked. */
	let discarding = $state.raw<InProgress | null>(null);
	let busy = $state(false);
	let failed = $state(false);
	let body = $state<HTMLElement>();

	const start = () => import('#lib/client/workout/start.ts');

	$effect(() => {
		if (!open) discarding = null;
	});

	function finish() {
		open = false;
		onfinish();
	}

	async function ask() {
		failed = false;
		const held = await (await start()).inProgress(store).catch(() => null);
		if (held?.workoutId !== view.workout.id) return;
		discarding = held;
		await tick();
		// Keep it is in the sheet's footer, beside the body rather than in it.
		body?.closest('dialog')?.querySelector<HTMLElement>('[data-testid="keep-workout"]')?.focus();
	}

	async function discard() {
		if (!discarding) return;
		busy = true;
		const { discardInProgress } = await start();
		const done = await discardInProgress(discarding, { store }).catch(() => false);
		busy = false;
		if (done) open = false;
		else failed = true;
	}
</script>

<IconButton
	icon="more"
	label="Workout options"
	onclick={(event) => {
		// Safari never focuses a tapped button: the sheet returns focus to what has it.
		(event.currentTarget as HTMLElement).focus();
		open = true;
	}}
	data-testid="workout-menu-button"
/>

<BottomSheet
	bind:open
	title={discarding ? 'Discard this workout?' : view.workout.title}
	description={discarding ? undefined : 'Workout'}
	data-testid="workout-menu"
>
	<div bind:this={body}>
		{#if discarding}
			<p class="consequence" data-testid="discard-consequence">
				{discarding.startSeq === null
					? 'It has synced, so discarding marks it abandoned on the server. It never shows as done.'
					: "It hasn't synced yet, so discarding deletes it from this device, with everything logged in it."}
			</p>
			{#if failed}
				<p class="error" role="alert">Not saved on this device. Try again.</p>
			{/if}
		{/if}
	</div>
	{#snippet footer()}
		<div class="actions">
			{#if discarding}
				<Button
					block
					variant="secondary"
					disabled={busy}
					onclick={() => (discarding = null)}
					data-testid="keep-workout">Keep it</Button
				>
				<Button
					block
					variant="danger"
					icon="trash"
					loading={busy}
					onclick={discard}
					data-testid="confirm-discard">Discard workout</Button
				>
			{:else}
				<Button block icon="check" onclick={finish} data-testid="menu-finish">Finish workout</Button
				>
				<Button block variant="secondary" icon="trash" onclick={ask} data-testid="menu-discard"
					>Discard workout</Button
				>
			{/if}
		</div>
	{/snippet}
</BottomSheet>

<style>
	.consequence {
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
		color: var(--color-text-secondary);
	}

	.error {
		margin-top: var(--space-3);
		color: var(--color-danger);
		font-weight: var(--weight-medium);
	}

	.actions {
		display: grid;
		gap: var(--space-2);
	}
</style>
