<script module lang="ts">
	// The strength view, its selectors and its set words stay out of the initial JavaScript, as the
	// run and session views do: fetched at once, while the Shell restores the workout, which keeps
	// its skeleton until both are done. A chunk gone after a deploy turns the page to 'App updated'.
	// Asked as the route's module is evaluated, before the page hydrates, so the view's chunks
	// load while the app starts rather than after it.
	const view = import.meta.env.SSR ? null : import('./StrengthView.svelte');
	// Handled when the Shell mounts; until then a failure is not unhandled.
	view?.catch(() => {});
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import Prepaint from './Prepaint.svelte';
	import Shell from './Shell.svelte';
	import type * as StartFlow from './StartFlow.svelte';
	import type StrengthViewComponent from './StrengthView.svelte';

	// The route's reducer table: loaded while the Shell restores, with the projection.
	const table = () => import('#lib/domain/workout/reducers/tables.ts').then((m) => m.strengthTable);
	let StrengthView = $state.raw<typeof StrengthViewComponent | null>(null);
	const ready = () => view!.then((module) => (StrengthView = module.default));

	// The Shell's prepaint (Prepaint.svelte): the current exercise this device kept, painted
	// before the app starts, in the skeleton's place (prepaint.ts).

	// ?start=<lineage> or ?new=run|other starts a workout (StartFlow.svelte, lazy). Read once
	// mounted, never while prerendering: SvelteKit refuses the query there.
	let start = $state.raw<() => Promise<typeof StartFlow>>();
	onMount(() => {
		if (/[?&](start|new)=/.test(location.search)) start = () => import('./StartFlow.svelte');
	});
</script>

<svelte:head>
	<title>Workout · Performance Coach</title>
</svelte:head>

<Shell {table} {ready} {start}>
	{#snippet prepaint()}<Prepaint />{/snippet}
	{#snippet children(snapshot, load, active)}
		{#if StrengthView}
			<StrengthView {snapshot} {load} {active} />
		{/if}
	{/snippet}
</Shell>
