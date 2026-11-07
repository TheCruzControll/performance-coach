<!--
  @component
  The workout pages' header: Minimise (back to Today, where the resume bar waits) with the sync
  status (small, quiet beside logging, once it has loaded on idle), the workout's title and the
  stopwatch. Two rows on a phone (Minimise and the status; the title and the stopwatch), one row
  from 1024 px,
  where it spans the page over the columns. It applies --safe-top itself: no shell does here.
  With no title yet (restoring) the title's line is reserved, so nothing moves when it arrives.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import type { StopwatchState } from '#lib/domain/workout/index.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import Skeleton from '#lib/ui/components/Skeleton.svelte';
	import Stopwatch from '#lib/ui/workout/Stopwatch.svelte';
	import type { Snippet } from 'svelte';

	interface Props {
		/** null while restoring. */
		title: string | null;
		/** null when there is no workout to time. */
		stopwatch: StopwatchState | null;
		/** The sync status, once it has loaded. */
		status?: Snippet;
	}

	let { title, stopwatch, status }: Props = $props();
</script>

<header class="header" data-testid="workout-header">
	<div class="inner">
		<div class="minimise">
			<Button variant="ghost" icon="chevron-down" href={resolve('/(app)/today')}>Minimise</Button>
			{@render status?.()}
		</div>
		<div class="time">
			{#if stopwatch}<Stopwatch {stopwatch} />{/if}
		</div>
		<div class="title">
			{#if title === null}
				<Skeleton width="12rem" height="2rem" radius="var(--radius-sm)" />
			{:else}
				<h1>{title}</h1>
			{/if}
		</div>
	</div>
</header>

<style>
	.header {
		padding: calc(var(--safe-top) + var(--space-2)) max(var(--gutter), var(--safe-right))
			var(--space-3) max(var(--gutter), var(--safe-left));
	}

	.inner {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		grid-template-areas:
			'minimise minimise'
			'title time';
		column-gap: var(--space-3);
		align-items: center;
		row-gap: var(--space-2);
		max-width: var(--content-column);
		margin: 0 auto;
	}

	.minimise {
		grid-area: minimise;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		min-width: 0;
		margin-left: calc(-1 * var(--space-3));
	}

	.time {
		grid-area: time;
		min-height: 2rem;
	}

	.title {
		grid-area: title;
		display: flex;
		align-items: center;
		min-height: 2.5rem;
		min-width: 0;
	}

	h1 {
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-tight);
		line-height: var(--leading-snug);
		overflow-wrap: anywhere;
	}

	@media (width >= 64rem) {
		.header {
			border-bottom: 1px solid var(--color-border);
			background: var(--color-surface-1);
		}

		.inner {
			grid-template-columns: auto 1fr auto;
			grid-template-areas: 'minimise title time';
			column-gap: var(--space-6);
			max-width: var(--workout-width);
		}

		.minimise {
			margin-left: 0;
		}
	}
</style>
