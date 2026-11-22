<!--
  @component
  The workout menu: the header's More button (an IconButton, 44 px, with hover and :focus-visible
  states; the Shell loads it on idle with the store, its place kept meanwhile) and its sheet:
  Finish workout, which opens the finish sheet; Settings, which opens the workout settings
  (SettingsSheet.svelte, loaded then) over the menu, so closing them comes back to it; and
  Discard workout, which asks first and says what it does. The workout is kept in History as
  abandoned, synced or not, since its start may have reached the server; only one whose start the
  server refused is deleted from this device with everything logged in it (start.ts's
  discardInProgress, the start conflict's Discard). A BottomSheet: a centred dialog from 1024 px,
  Escape closes it and focus returns. Every action is a primitive Button (44 px, hover and
  :focus-visible states).
  Once a set is logged, a visible Finish (HeaderFinish.svelte, exported from here so it loads with
  the menu) sits at the end of the title's line too, so finishing never means hunting through the
  menu; the menu keeps Finish workout.
-->
<script module lang="ts">
	export { default as HeaderFinish } from './HeaderFinish.svelte';
</script>

<script lang="ts">
	import type { InProgress } from '#lib/client/workout/start.ts';
	import type { WorkoutStore } from '#lib/client/workout/store.ts';
	import type { WorkoutView } from '#lib/domain/workout/index.ts';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import IconButton from '#lib/ui/components/IconButton.svelte';
	import { tick } from 'svelte';
	import type SettingsSheet from './SettingsSheet.svelte';

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

	let Settings = $state.raw<typeof SettingsSheet | null>(null);
	let settingsOpen = $state(false);
	let settingsLoading = $state(false);
	let settingsFailed = $state(false);

	async function settings(event: MouseEvent) {
		const button = event.currentTarget as HTMLElement;
		settingsFailed = false;
		settingsLoading = true;
		Settings ??= (await import('./SettingsSheet.svelte').catch(() => null))?.default ?? null;
		settingsLoading = false;
		settingsFailed = Settings === null;
		if (!Settings) return;
		// Disabled while it loaded, the button lost focus (Chromium): give it back, so closing the
		// settings returns there rather than to the menu.
		await tick();
		button.focus();
		settingsOpen = true;
	}

	$effect(() => {
		if (open) return;
		discarding = null;
		settingsFailed = false;
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
				{discarding.startParked === 'refused'
					? 'The server refused it, so discarding deletes it from this device, with everything logged in it.'
					: 'Discarding keeps it in your history as abandoned. It never shows as done.'}
			</p>
			{#if failed}
				<p class="error" role="alert">Not saved on this device. Try again.</p>
			{/if}
		{:else if settingsFailed}
			<p class="error" role="alert">
				Couldn't open the settings. Check your connection and try again.
			</p>
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
				<Button
					block
					variant="secondary"
					icon="timer"
					loading={settingsLoading}
					onclick={settings}
					data-testid="menu-settings">Settings</Button
				>
				<Button block variant="secondary" icon="trash" onclick={ask} data-testid="menu-discard"
					>Discard workout</Button
				>
			{/if}
		</div>
	{/snippet}
</BottomSheet>

{#if Settings}<Settings bind:open={settingsOpen} />{/if}

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
