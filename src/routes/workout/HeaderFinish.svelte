<!--
  @component
  The header's visible Finish, once a set is logged (hasLoggedSet), so finishing never means
  hunting through the workout menu, which keeps Finish workout too. It loads with the menu
  (WorkoutMenu.svelte exports it) and sits at the end of the title's line, just before the
  stopwatch: it joins the row without moving the stopwatch, the More button or the title's start,
  so nothing shifts when it arrives, mid-set or on idle after a reload.
-->
<script lang="ts">
	import type { WorkoutView } from '#lib/domain/workout/index.ts';
	import { hasLoggedSet } from '#lib/domain/workout/selectors.ts';
	import Button from '#lib/ui/components/Button.svelte';

	interface Props {
		view: WorkoutView;
		onfinish: () => void;
	}

	let { view, onfinish }: Props = $props();
</script>

{#if hasLoggedSet(view)}
	<span class="finish">
		<Button size="sm" variant="secondary" onclick={onfinish} data-testid="header-finish"
			>Finish</Button
		>
	</span>
{/if}

<style>
	/* Pushed to the end of the title's line; apart from the title by the header's own gap. */
	.finish {
		flex: none;
		display: flex;
		margin-left: auto;
		padding-left: var(--space-3);
	}
</style>
