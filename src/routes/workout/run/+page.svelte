<script lang="ts">
	import { runTable } from '#lib/domain/workout/reducers/run.ts';
	import Shell from '../Shell.svelte';
	import type RunViewComponent from './RunView.svelte';

	// The run logger, its pace maths and its mutation builder stay out of the initial JavaScript:
	// fetched at once, while the Shell restores the workout, which keeps its skeleton until both are
	// done. A chunk gone after a deploy turns the page to 'App updated' (the Shell's load).
	const view = import.meta.env.SSR ? null : import('./RunView.svelte');
	// Handled when the Shell mounts; until then a failure is not unhandled.
	view?.catch(() => {});
	let RunView = $state.raw<typeof RunViewComponent | null>(null);
	const ready = () => view!.then((module) => (RunView = module.default));
</script>

<svelte:head>
	<title>Run · Performance Coach</title>
</svelte:head>

<Shell table={runTable} {ready}>
	{#snippet children(snapshot, _load, active)}
		{#if RunView}
			<RunView {snapshot} {active} />
		{/if}
	{/snippet}
</Shell>
