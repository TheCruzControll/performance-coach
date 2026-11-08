<script lang="ts">
	import { otherTable } from '#lib/domain/workout/reducers/other.ts';
	import Shell from '../Shell.svelte';
	import type OtherViewComponent from './OtherView.svelte';

	// The session logger, its fields and its mutation builder stay out of the initial JavaScript:
	// fetched at once, while the Shell restores the workout, which keeps its skeleton until both are
	// done. A chunk gone after a deploy turns the page to 'App updated' (the Shell's load).
	const view = import.meta.env.SSR ? null : import('./OtherView.svelte');
	// Handled when the Shell mounts; until then a failure is not unhandled.
	view?.catch(() => {});
	let OtherView = $state.raw<typeof OtherViewComponent | null>(null);
	const ready = () => view!.then((module) => (OtherView = module.default));
</script>

<svelte:head>
	<title>Session · Performance Coach</title>
</svelte:head>

<Shell table={otherTable} {ready}>
	{#snippet children(snapshot, _load, active)}
		{#if OtherView}
			<OtherView {snapshot} {active} />
		{/if}
	{/snippet}
</Shell>
