<script lang="ts">
	import { otherTable } from '#lib/domain/workout/reducers/tables.ts';
	import Shell from '../Shell.svelte';
	import OtherView from './OtherView.svelte';
</script>

<svelte:head>
	<title>Session · Performance Coach</title>
</svelte:head>

<Shell table={otherTable}>
	{#snippet children(snapshot, _load, active)}
		<OtherView {snapshot} {active} />
	{/snippet}
</Shell>
