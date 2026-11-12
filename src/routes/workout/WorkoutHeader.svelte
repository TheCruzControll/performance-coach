<!--
  @component
  The workout pages' header: Minimise (back to Today, where the resume bar waits) with the sync
  status (small, quiet beside logging, once it has loaded on idle), the workout's title, the
  stopwatch and, beside it, the workout menu's More button (Finish, Discard), with a visible Finish
  at the end of the title's line once a set is logged. Two rows on a phone (Minimise and the
  status; the title and the stopwatch), one row from 1024 px,
  where it spans the page over the columns. At a large text size the status takes a row of its own
  under Minimise rather than overflow; its width is the same in every state, so which line it
  takes never depends on what it says. It applies --safe-top itself: no shell does here.
  With no title yet (restoring) the title's line is reserved, so nothing moves when it arrives.
  The visible Finish takes its room from the title's line, never the stopwatch's: the stopwatch
  and More stay put, and on a phone the title keeps to one line (an ellipsis if it must), so it
  is the same height with Finish or without. The title comes before the stopwatch in the markup,
  as it does on screen, so the tab order runs Minimise, Finish, the stopwatch, More.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import Button from '#lib/ui/components/Button.svelte';
	import Skeleton from '#lib/ui/components/Skeleton.svelte';
	import type { Snippet } from 'svelte';

	interface Props {
		/** null while restoring. */
		title: string | null;
		/** The stopwatch, when there is a workout to time and it has loaded. */
		time?: Snippet;
		/** The sync status, once it has loaded. */
		status?: Snippet;
		/** The workout menu's button, while a workout is in progress. */
		menu?: Snippet;
		/** The visible Finish, at the end of the title's line, once a set is logged. */
		finish?: Snippet;
	}

	let { title, time, status, menu, finish }: Props = $props();
</script>

<header class="header" data-testid="workout-header">
	<div class="inner">
		<div class="minimise">
			<Button variant="ghost" icon="chevron-down" href={resolve('/(app)/today')}>Minimise</Button>
			{@render status?.()}
		</div>
		<div class="title">
			{#if title === null}
				<Skeleton width="12rem" height="2rem" radius="var(--radius-sm)" />
			{:else}
				<h1>{title}</h1>
			{/if}
			{@render finish?.()}
		</div>
		<div class="time">
			{@render time?.()}
			{@render menu?.()}
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
		flex-wrap: wrap;
		justify-content: space-between;
		gap: var(--space-3);
		min-width: 0;
		margin-left: calc(-1 * var(--space-3));
	}

	.time {
		grid-area: time;
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-height: 2rem;
	}

	.title {
		grid-area: title;
		display: flex;
		align-items: center;
		min-height: 2.5rem;
		min-width: 0;
	}

	/* A step down on a phone, where the stopwatch and the More button share the title's row: a
	   usual title keeps to one line, so the header is the height the restoring state reserves. */
	h1 {
		font-size: var(--text-xl);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-tight);
		line-height: var(--leading-snug);
		overflow-wrap: anywhere;
	}

	/* On a phone the title keeps to its one line, ending in an ellipsis if it must, with the
	   visible Finish beside it or not: the header never changes height when Finish arrives. */
	@media (width < 64rem) {
		h1 {
			overflow: hidden;
			white-space: nowrap;
			text-overflow: ellipsis;
		}
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

		h1 {
			font-size: var(--text-2xl);
		}
	}
</style>
