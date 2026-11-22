<!--
  @component
  The exercise detail's trends (trends.ts), loaded after hydration. On the page the server
  rendered, they are static markup (`served`), kept as sent while their code loads, and the live
  section takes its place once it has. After a client navigation it holds the section's room while
  the code loads: placeholders laid out as the section is (the e1RM tile beside its context, the
  chart beside the rep maxes, the PRs beside the top sets and RPE, a row per recent session), or,
  if the import failed, 'Couldn’t load this lift’s trends' with Retry, which imports it again in
  place (WebKit fetches anew). If that fails too while online, the page reloads: Chromium keeps a
  failed module fetch for the document's lifetime, and after a deploy the old chunk is gone.
  Offline, the notice stays. The header's verdict works throughout.
-->
<script lang="ts">
	import { onMount, type Component } from 'svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import ServedInPlace from '../../../today/panels/ServedInPlace.svelte';
	import ServedMarkup from '../../../today/panels/ServedMarkup.svelte';
	import type { ExerciseDetail } from './load';
	import { preloadTrends, settledTrends, type TrendsProps } from './trends';

	interface Props {
		detail: ExerciseDetail;
		/** The section as the server rendered it (+page.ts), kept as sent until its code arrives. */
		served?: string;
	}

	let { detail, served }: Props = $props();

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

	/** The PRs' rows, and the groups (a subheading each) they fall in; none is a line saying so. */
	const prs = $derived(detail.prs.e1rm.length + detail.prs.volume.length);
	const groups = $derived((detail.prs.e1rm.length ? 1 : 0) + (detail.prs.volume.length ? 1 : 0));
	/** The rep maxes that beat an earlier record: a second line each. */
	const previous = $derived(detail.repMaxes.filter((row) => row.previous).length);

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

	/** A tap on Retry after a failure: fails again online, and the page reloads. */
	function retry() {
		outcome = current;
		fetchTrends();
	}
</script>

{#if held}
	<Served markup={held} />
{:else if Trends}
	<Trends {detail} />
{:else if failed}
	<div class="failed" data-testid="exercise-trends-error">
		<Notice tone="danger" title="Couldn’t load this lift’s trends">
			Your training is safe. Check your connection, then try again.
		</Notice>
		<Button variant="secondary" icon="refresh" onclick={retry}>Try again</Button>
	</div>
{:else}
	<div class="reserve" aria-busy="true" data-testid="exercise-trends">
		<span class="visually-hidden">Loading…</span>
		{#if !detail.waiting}
			<div class="part lead">
				<span class="bone tile"></span>
				<span class="bone about" style:--rows={detail.markers.length}></span>
			</div>
		{/if}
		<div class="pair">
			{#if !detail.waiting}<span class="bone chart"></span>{/if}
			<div class="part">
				<span class="bone table" style:--rows={detail.repMaxes.length} style:--previous={previous}
				></span>
			</div>
		</div>
		<div class="pair">
			{#if !detail.waiting}
				<div class="part">
					<span class="bone prs" style:--rows={prs} style:--groups={groups}></span>
				</div>
			{/if}
			<div class="stack">
				{#if detail.topSets.length}
					<div class="part">
						<span class="bone list" style:--rows={detail.topSets.length}></span>
					</div>
				{/if}
				{#if !detail.waiting}<div class="part"><span class="bone tile"></span></div>{/if}
			</div>
		</div>
		{#if detail.recent.length}
			<div class="part rows">
				{#each detail.recent as { id } (id)}<span class="bone"></span>{/each}
			</div>
		{/if}
	</div>
{/if}

<style>
	/*
	 * The room the live section takes, laid out as it is (ExerciseTrends): each part's heading
	 * above, the e1RM tile beside its context and the profile's maxes, the chart's frame beside
	 * the rep maxes' rows, the PRs under their groups' headings beside the top sets and the RPE
	 * tile, a row per recent session. Heights measured from the live section on a phone and in a
	 * desktop window.
	 */
	.reserve,
	.pair,
	.stack {
		display: grid;
		gap: var(--space-6);
		min-width: 0;
	}

	/* A Section's heading and the gap under it ('Estimated 1RM': md). */
	.part {
		display: grid;
		gap: var(--space-2);
		padding-top: 1.875rem;
	}

	.bone {
		block-size: var(--bone);
		border-radius: var(--radius-lg);
		background: var(--color-surface-2);
	}

	/* A TrendTile: the e1RM's, and RPE's. */
	.tile {
		--bone: 9.8125rem;
	}

	/* The e1RM's context (its line wraps on a phone, then 'How it’s worked out'), then each max. */
	.lead {
		gap: var(--space-4);
		padding-top: 2.125rem;
	}

	.about {
		--bone: calc(5.25rem + min(var(--rows), 1) * 0.25rem + var(--rows) * 2rem);
	}

	.chart {
		--bone: 26.0625rem;
	}

	/* The rep maxes: the table's head, a row per rep count, a line more for each it beat. */
	.table {
		--bone: calc(2.125rem + var(--rows) * 2.375rem + var(--previous) * 1.1875rem);
	}

	/* The PRs: a subheading per group, a row per record; none is a line saying so. */
	.prs {
		--bone: max(
			1.25rem,
			calc(var(--groups) * 2.625rem - min(var(--groups), 1) * 0.5rem + var(--rows) * 2.5625rem)
		);
	}

	.list {
		--bone: calc(var(--rows) * 2.5625rem);
	}

	.rows {
		grid-template-columns: repeat(auto-fill, minmax(min(100%, 20rem), 1fr));
	}

	.rows .bone {
		--bone: 4.4375rem;
	}

	.failed {
		display: grid;
		justify-items: start;
		gap: var(--space-3);
	}

	@container (width >= 44rem) {
		.pair {
			grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
			align-items: start;
		}

		.lead {
			grid-template-columns: minmax(0, 18rem) minmax(0, 1fr);
			column-gap: var(--space-6);
			align-items: start;
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
