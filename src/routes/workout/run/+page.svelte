<script lang="ts">
	import { runTable } from '#lib/domain/workout/reducers/tables.ts';
	import Shell from '../Shell.svelte';
	import RunView from './RunView.svelte';
</script>

<svelte:head>
	<title>Run · Performance Coach</title>
</svelte:head>

<Shell table={runTable}>
	{#snippet children(snapshot, _load, active)}
		<RunView {snapshot} {active} />
	{/snippet}
</Shell>
