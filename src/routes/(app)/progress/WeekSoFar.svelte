<!--
  @component
  This week on Progress: sessions, training load and distance from Monday to today, set against
  the same days of last week (week.server.ts composes the words), and how training load is worked
  out. Moved from Today as it was (v2/06a) until v2/14 redraws Progress's home. Streamed: the
  server's render waits for it, and a client navigation (a view or period switch, Retry, a
  preload on hover) keeps the last figures that settled until the new ones land, so the tiles
  never blank and nothing below them moves; they are empty and busy only while none have settled
  yet. A failed read is a designed error with Retry, and replaces the figures shown. The
  disclosure is always there, so the section keeps its height.
-->
<script lang="ts">
	import Button from '#lib/ui/components/Button.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import Stat from '#lib/ui/components/Stat.svelte';
	import { EMPTY_TILES, LOAD_METHOD, type WeekSoFarView, type WeekTile } from './week-words';

	interface Props {
		/** Settled when the server rendered Progress; a promise after a client navigation. */
		week: WeekSoFarView | Promise<WeekSoFarView> | undefined;
		/** The page's Retry is under way. */
		retrying: boolean;
		onretry: () => void;
	}

	let { week, retrying, onretry }: Props = $props();

	/** The last view that settled, shown while the next one is on its way. */
	let last = $state<WeekSoFarView>();

	$effect(() => {
		const current = week;
		if (!(current instanceof Promise)) {
			last = current;
			return;
		}
		let live = true;
		current.then(
			(view) => {
				if (live) last = view;
			},
			() => {
				if (live) last = { failed: true };
			}
		);
		return () => {
			live = false;
		};
	});

	const pending = $derived(week instanceof Promise);
	/** Settled on the server and while hydrating; else the last that settled, if any has. */
	const view = $derived(week instanceof Promise ? last : week);
</script>

{#snippet tiles(list: readonly WeekTile[], busy = false)}
	<div class="stats" aria-busy={busy || undefined}>
		{#each list as tile (tile.id)}
			<Stat
				label={tile.label}
				value={tile.value}
				unit={tile.unit}
				caption={tile.caption}
				data-testid="week-stat"
			/>
		{/each}
	</div>
{/snippet}

<Section title="This week" data-testid="week-so-far">
	{#if pending && !view}
		{@render tiles(EMPTY_TILES, true)}
		<p class="line">Counting this week…</p>
	{:else if !view || view.failed}
		{@render tiles(EMPTY_TILES)}
		<div class="error" data-testid="week-so-far-error">
			<p class="line" role="status">Couldn’t load this week’s numbers.</p>
			<Button variant="secondary" icon="refresh" loading={retrying} onclick={onretry}>
				Try again
			</Button>
		</div>
	{:else}
		{@render tiles(view.tiles)}
		<p class="line" data-testid="week-context">{view.against}</p>
	{/if}
	<details class="how">
		<summary><Icon name="chevron-right" size={16} strokeWidth={2} />How it’s worked out</summary>
		<p>{LOAD_METHOD}</p>
	</details>
</Section>

<style>
	.stats {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--space-2);
	}

	/* The line and the disclosure, as the dashboards' metric context reads. */
	.line,
	.how p {
		font-size: var(--text-xs);
		line-height: var(--leading-normal);
		color: var(--color-text-secondary);
	}

	.error {
		display: grid;
		justify-items: start;
		gap: var(--space-2);
	}

	.how summary {
		display: flex;
		align-items: center;
		gap: var(--space-1-5);
		min-height: var(--touch-target);
		width: fit-content;
		padding: 0 var(--space-2);
		margin-inline: calc(var(--space-2) * -1);
		border-radius: var(--radius-sm);
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		cursor: pointer;
		list-style: none;
	}

	.how summary::-webkit-details-marker {
		display: none;
	}

	.how[open] summary :global(.icon) {
		transform: rotate(90deg);
	}

	.how summary:active {
		background: var(--color-surface-2);
	}

	@media (hover: hover) and (pointer: fine) {
		.how summary:hover {
			background: var(--color-surface-2);
			color: var(--color-text);
		}
	}

	.how p {
		font-size: var(--text-sm);
	}
</style>
