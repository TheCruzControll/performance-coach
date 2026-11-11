<script module lang="ts">
	// The session logger, its fields and its mutation builder stay out of the initial JavaScript:
	// fetched at once, while the Shell restores the workout, which keeps its skeleton until both are
	// done. A chunk gone after a deploy turns the page to 'App updated' (the Shell's load).
	// Asked as the route's module is evaluated, before the page hydrates, so the view's chunks
	// load while the app starts rather than after it.
	const view = import.meta.env.SSR ? null : import('./OtherView.svelte');
	// Handled when the Shell mounts; until then a failure is not unhandled.
	view?.catch(() => {});
</script>

<script lang="ts">
	import Shell from '../Shell.svelte';
	import type OtherViewComponent from './OtherView.svelte';

	// The route's reducer table: loaded while the Shell restores, with the projection.
	const table = () => import('#lib/domain/workout/reducers/other.ts').then((m) => m.otherTable);
	let OtherView = $state.raw<typeof OtherViewComponent | null>(null);
	const ready = () => view!.then((module) => (OtherView = module.default));
</script>

<svelte:head>
	<title>Session · Performance Coach</title>
</svelte:head>

<Shell {table} {ready}>
	{#snippet children(snapshot, _load, active)}
		{#if OtherView}
			<OtherView {snapshot} {active} />
		{/if}
	{/snippet}
</Shell>
