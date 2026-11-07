<!--
  @component
  No workout in progress on this device: where to start one. Nothing links to the workout pages
  yet (dark launch), so this is what a bare /workout shows; workout-start adds starting here.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import Button from '#lib/ui/components/Button.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
</script>

<EmptyState
	icon="timer"
	title="No workout in progress"
	description="Start today's session from Today. Once it starts, it is saved on this device as you go, even offline."
	data-testid="workout-empty"
>
	{#snippet actions()}
		<Button href={resolve('/(app)/today')} iconEnd="arrow-right">Go to Today</Button>
	{/snippet}
</EmptyState>
