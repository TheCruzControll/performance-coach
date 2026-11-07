<script lang="ts">
	import { strengthTable } from '#lib/domain/workout/reducers/tables.ts';
	import Shell from './Shell.svelte';
	import StrengthView from './StrengthView.svelte';
</script>

<svelte:head>
	<title>Workout · Performance Coach</title>
</svelte:head>

<Shell table={strengthTable}>
	{#snippet children({ view })}
		<StrengthView {view} />
	{/snippet}
</Shell>
