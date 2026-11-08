<script lang="ts">
	import Shell from './Shell.svelte';
	import type StrengthViewComponent from './StrengthView.svelte';

	// The strength view, its selectors and its set words stay out of the initial JavaScript, as the
	// run and session views do: fetched at once, while the Shell restores the workout, which keeps
	// its skeleton until both are done. A chunk gone after a deploy turns the page to 'App updated'.
	const view = import.meta.env.SSR ? null : import('./StrengthView.svelte');
	// Handled when the Shell mounts; until then a failure is not unhandled.
	view?.catch(() => {});
	// The route's reducer table: loaded while the Shell restores, with the projection.
	const table = () => import('#lib/domain/workout/reducers/tables.ts').then((m) => m.strengthTable);
	let StrengthView = $state.raw<typeof StrengthViewComponent | null>(null);
	const ready = () => view!.then((module) => (StrengthView = module.default));
</script>

<svelte:head>
	<title>Workout · Performance Coach</title>
</svelte:head>

<Shell {table} {ready}>
	{#snippet children(snapshot, load, active)}
		{#if StrengthView}
			<StrengthView {snapshot} {load} {active} />
		{/if}
	{/snippet}
</Shell>
