<!--
  @component
  Overview's trends (trends.ts), loaded after hydration. On the page the server rendered, they are
  static markup (`served`), kept as sent while their code loads, and the live section takes its
  place once it has. After a client navigation it holds the section's room while the code loads:
  placeholders laid out as the section is (the tiles' grid, a frame per chart), or, if the import
  failed, 'Couldn’t load your trends' with Retry, which imports it again in place (WebKit fetches
  anew). If that fails too while online, Progress reloads: Chromium keeps a failed module fetch for
  the document's lifetime, and after a deploy the old chunk is gone. Offline, the notice stays.
  The verdicts above work throughout.
-->
<script lang="ts">
	import { onMount, type Component } from 'svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import ServedInPlace from '../today/panels/ServedInPlace.svelte';
	import ServedMarkup from '../today/panels/ServedMarkup.svelte';
	import type { OverviewData } from './load';
	import { preloadTrends, settledTrends, type TrendsProps } from './trends';

	interface Props {
		overview: OverviewData;
		/** The section as the server rendered it (+page.ts), kept as sent until its code arrives. */
		served?: string;
	}

	let { overview, served }: Props = $props();

	/** What the import came to, as of the last render or Retry. */
	let outcome = $state.raw<Component<TrendsProps> | Error | undefined>();
	const current = $derived(outcome ?? settledTrends());
	const Trends = $derived(current instanceof Error ? undefined : current);
	let loading = $state(false);
	const failed = $derived(current instanceof Error && !loading);
	/**
	 * The served markup stays through hydration, whatever the import came to by then, and until
	 * it comes to something: the section, or Retry.
	 */
	let mounted = $state(false);
	onMount(() => (mounted = true));
	const held = $derived(mounted && current !== undefined ? undefined : served);
	/** The markup on the server; in the browser, the same element kept as sent (no props). */
	const Served: Component<{ markup: string }> = import.meta.env.SSR
		? ServedMarkup
		: (ServedInPlace as Component<{ markup: string }>);

	/** The placeholders' frames: one per chart the section will draw. */
	const charts = $derived(
		overview.stage === 'history' ? (overview.charts.load ? 1 : 0) + overview.charts.lifts.length : 0
	);

	async function fetchTrends() {
		loading = true;
		await preloadTrends();
		const next = settledTrends() as Component<TrendsProps> | Error;
		if (next instanceof Error && outcome instanceof Error && navigator.onLine) {
			return location.reload();
		}
		outcome = next;
		loading = false;
	}

	// Not imported yet (a client navigation, or +page.ts has not finished it): import it now.
	$effect(() => {
		if (current === undefined && !loading) fetchTrends();
	});

	/** A tap on Retry after a failure: fails again online, and Progress reloads. */
	function retry() {
		outcome = current;
		fetchTrends();
	}
</script>

{#if held}
	<Served markup={held} />
{:else if Trends}
	<Trends {overview} />
{:else if failed}
	<div class="failed" data-testid="overview-trends-error">
		<Notice tone="danger" title="Couldn’t load your trends">
			Your verdicts above still stand. Check your connection, then try again.
		</Notice>
		<Button variant="secondary" icon="refresh" onclick={retry}>Retry</Button>
	</div>
{:else}
	<div class="reserve" aria-busy="true" data-testid="overview-trends">
		<span class="visually-hidden">Loading…</span>
		{#if overview.stage !== 'new'}
			<div class="part tiles">
				{#each overview.tiles as { id } (id)}<span class="bone"></span>{/each}
			</div>
		{/if}
		{#if overview.stage !== 'history'}
			<div class="part">
				<span class="bone" style:--bone="{overview.timeline.length * 4.2}rem"></span>
			</div>
		{:else if charts}
			<div class="part charts">
				{#each { length: charts }, i (i)}<span class="bone"></span>{/each}
			</div>
		{/if}
	</div>
{/if}

<style>
	/*
	 * The room the live section takes, laid out as it is: each part's heading above, the tiles'
	 * grid with the method's summary under it, a frame per chart, the timeline's rows. Heights
	 * measured from the live section on a phone and in a desktop window.
	 */
	.reserve {
		display: grid;
		gap: var(--space-6);
	}

	/* A Section's heading and the gap under it (Key figures and Trends: md, the timeline: sm). */
	.part {
		display: grid;
		gap: var(--space-3);
		padding-top: 2.1rem;
	}

	.part:not(.tiles, .charts) {
		padding-top: 1.85rem;
	}

	.tiles {
		grid-template-columns: repeat(auto-fit, minmax(min(100%, 10.5rem), 1fr));
		padding-bottom: calc(var(--touch-target) + var(--space-3));
	}

	.bone {
		block-size: var(--bone);
		border-radius: var(--radius-lg);
		background: var(--color-surface-2);
	}

	.tiles .bone {
		--bone: 17.625rem;
	}

	.charts .bone {
		--bone: 24.0625rem;
	}

	.charts .bone:first-child {
		--bone: 27.0625rem;
	}

	.failed {
		display: grid;
		justify-items: start;
		gap: var(--space-3);
	}

	@container (width >= 44rem) {
		.charts {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}

	/* Five tiles in one row: each line of a tile has the room it needs. */
	@container (width >= 64rem) {
		.tiles .bone {
			--bone: 16.6875rem;
		}
	}

	@media (prefers-reduced-motion: no-preference) {
		.bone {
			animation: pulse 1.6s ease-in-out infinite alternate;
		}
	}

	@keyframes pulse {
		to {
			opacity: 0.55;
		}
	}
</style>
