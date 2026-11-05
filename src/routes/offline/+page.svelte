<script lang="ts">
	import Button from '#lib/ui/components/Button.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
</script>

<svelte:head>
	<title>Offline · Performance Coach</title>
</svelte:head>

<main id="main" class="offline">
	<EmptyState
		icon="wifi-off"
		tone="neutral"
		title="You're offline"
		description="Reconnect to continue. Offline workout logging, with sync when you're back, arrives with the workout app."
	>
		{#snippet actions()}
			<Button icon="refresh" onclick={() => location.reload()}>Try again</Button>
		{/snippet}
	</EmptyState>
</main>

<style>
	.offline {
		display: grid;
		place-content: center;
		min-height: 100dvh;
		padding: var(--safe-top) var(--gutter) var(--safe-bottom);
	}
</style>
