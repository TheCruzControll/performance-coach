<!--
  @component
  Asks before signing out deletes the workout changes this device has not synced (the offline
  workout sync ADR, 'Losing the session'): sign out and delete them, or stay signed in and keep
  every one. Shared by Security and the recovery screen, which load it only when they need to ask.
-->
<script lang="ts">
	import BottomSheet from './BottomSheet.svelte';
	import Button from './Button.svelte';

	interface Props {
		open: boolean;
		/** How many workout changes have not reached the server. */
		count: number;
		onconfirm: () => void;
	}

	let { open = $bindable(), count, onconfirm }: Props = $props();

	const changes = $derived(count === 1 ? '1 workout change' : `${count} workout changes`);
	const words = $derived(
		count === 1
			? 'It hasn’t reached the server yet. Signing out removes it from this device.'
			: 'They haven’t reached the server yet. Signing out removes them from this device.'
	);
</script>

<BottomSheet
	bind:open
	title="Sign out and delete {changes}?"
	description={words}
	data-testid="signout-pending-sheet"
>
	<div class="choices">
		<Button variant="danger" block onclick={onconfirm} data-testid="signout-delete">
			Sign out and delete
		</Button>
		<Button variant="ghost" block onclick={() => (open = false)} data-testid="signout-stay">
			Stay signed in
		</Button>
	</div>
</BottomSheet>

<style>
	.choices {
		display: grid;
		gap: var(--space-3);
		padding-bottom: var(--space-2);
	}
</style>
