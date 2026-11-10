<!--
  @component
  No workout in progress on this device: where to start one. Today starts the planned sessions;
  a strength session, a run or a Muay Thai or other session of the owner's own starts here
  (/workout?new=strength|run|other, StartFlow.svelte); a strength one starts empty, and each
  exercise is added from the library. Those links reload the page (data-sveltekit-reload),
  because the page reads the query once mounted; offline, the service worker serves it from the
  precache.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import Button from '#lib/ui/components/Button.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';

	const workout = resolve('/workout');
</script>

<EmptyState
	icon="timer"
	title="No workout in progress"
	description="Start today's session from Today, or log one of your own. Once it starts, it is saved on this device as you go, even offline."
	data-testid="workout-empty"
>
	{#snippet actions()}
		<Button href={resolve('/(app)/today')} iconEnd="arrow-right">Go to Today</Button>
		<span class="adhoc" data-sveltekit-reload>
			<Button
				variant="secondary"
				icon="plate"
				href={`${workout}?new=strength`}
				data-testid="adhoc-strength">Strength</Button
			>
			<Button variant="secondary" icon="pulse" href={`${workout}?new=run`} data-testid="adhoc-run"
				>Run</Button
			>
			<Button
				variant="secondary"
				icon="flame"
				href={`${workout}?new=other`}
				data-testid="adhoc-other">Muay Thai and other</Button
			>
		</span>
	{/snippet}
</EmptyState>

<style>
	/* The actions' own row: the ad-hoc links wrap beside Go to Today as one group of four. */
	.adhoc {
		display: contents;
	}
</style>
