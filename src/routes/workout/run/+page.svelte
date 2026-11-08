<script lang="ts">
	import { runTable } from '#lib/domain/workout/reducers/run.ts';
	import Shell from '../Shell.svelte';

	// The run logger, its pace maths and its mutation builder stay out of the initial JavaScript:
	// fetched at once, while the Shell restores the workout. A chunk gone after a deploy turns the
	// page to 'App updated' (the Shell's load).
	const view = import.meta.env.SSR ? null : import('./RunView.svelte');
	// Handled when the Shell renders the view; until then a failure is not unhandled.
	view?.catch(() => {});
</script>

<svelte:head>
	<title>Run · Performance Coach</title>
</svelte:head>

<Shell table={runTable}>
	{#snippet children(snapshot, load, active)}
		{#await view && load(() => view) then module}
			{#if module}
				<module.default {snapshot} {active} />
			{/if}
		{/await}
	{/snippet}
</Shell>
