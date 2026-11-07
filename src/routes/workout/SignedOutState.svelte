<!--
  @component
  The workout pages after a 401 (the offline workout sync ADR, 'Losing the session'): the engine
  has already deleted what the server holds, so this shows no workout details, only how many
  changes wait on this device and the way back. Signing in returns here, where a new engine sends
  them and the workout is rebuilt from the server.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import Button from '#lib/ui/components/Button.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';

	interface Props {
		/** Changes in the outbox. */
		waiting: number;
		/** This page's path: where signing in returns. */
		path: string;
	}

	let { waiting, path }: Props = $props();
	const changes = $derived(waiting === 1 ? '1 change' : `${waiting} changes`);
</script>

<EmptyState
	icon="lock"
	tone="neutral"
	title="Signed out on this device"
	description={`${changes} waiting — Sign in to continue. They're kept on this device and sync as soon as you're back.`}
	data-testid="workout-signed-out"
>
	{#snippet actions()}
		<Button icon="passkey" href={`${resolve('/')}?next=${encodeURIComponent(path)}`}>Sign in</Button
		>
	{/snippet}
</EmptyState>
