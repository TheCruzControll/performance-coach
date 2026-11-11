<!--
  @component
  One cycle review, scannable on an iPhone, every figure from the server (cycle-data.ts):

  - the hero: the block, its dates, the one-sentence summary, the adherence meter and the block's
    planned, completed, skipped and missed sessions in a line, each with its value in data-value
  - goal progress, strength and endurance progression (lazy LineCharts labelled estimated),
    accumulated fatigue, volume and intensity, exercise effectiveness leading to Keep or Rotate,
    and adherence with the deload need (ReviewSections: each collapses to its verdict line on a
    phone; from 1024 px every section shows in full; without JavaScript each chart is its table)
  - out of date (training logged in the block since): 'Computed before N later changes'
  - the next block: what it will be, why it changes and when it starts, then Start (NextCycleCard,
    loaded after hydration as a chart's frame is, so its code and styles, with ChoiceGroup's and
    WeekStrip's, are neither initial JS nor render-blocking CSS; until then, and without
    JavaScript, its title and words)
  - earlier cycles, each linking to its review (the page's ReviewList), and the version this one
    planned, in History
  - the write-up's slot, empty until the coach writes it (review-narrative-ui)

  A review written before M6 shows its summary alone.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import type { Snippet } from 'svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import type { CycleReviewData } from './cycle-data';
	import type { ReviewRow } from './load';
	import ReviewHero from './ReviewHero.svelte';
	import ReviewSections from './ReviewSections.svelte';
	import type { SectionView } from './sections';

	interface Props {
		review: CycleReviewData;
		/**
		 * The page's list, for the earlier cycles: passed in, so the list's code stays in the
		 * page's chunk rather than splitting into one this view shares (about 0.9 KB gzip).
		 */
		earlierCycles?: Snippet<[ReviewRow[]]>;
	}

	let { review, earlierCycles }: Props = $props();
	const adherence = $derived(review.adherence);
	// The m6-plan budget lever: the card's styles move into the lazily loaded part that uses them.
	const never = () => new Promise<never>(() => {});
	const card = import.meta.env.SSR ? never() : import('./NextCycleCard.svelte');
</script>

{#snippet after({ table }: SectionView)}
	{#if table}
		<table data-testid="section-table">
			<thead>
				<tr>
					<th scope="col">{table.rowHeader}</th>
					{#each table.columns as column (column.label)}<th scope="col">{column.label}</th>{/each}
				</tr>
			</thead>
			<tbody>
				{#each table.rows as row, i (i)}
					<tr>
						<th scope="row">{row.label}</th>
						{#each row.values as value, j (j)}<td>{value}</td>{/each}
					</tr>
				{/each}
			</tbody>
		</table>
	{/if}
{/snippet}

<article class="pc-cycle-review" aria-labelledby="review-title" data-testid="cycle-review">
	<ReviewHero
		eyebrow="Cycle review · {review.dates}"
		title={review.title}
		summary={review.summary}
		{adherence}
	>
		{#if adherence}
			<p data-testid="review-adherence-words">{adherence.words}</p>
			<p>
				{#each adherence.counts as count, i (count.label)}{i ? ' · ' : ''}<span
						class="numeric"
						data-value={count.value}
						data-testid="review-count-{count.label.toLowerCase()}"
						>{count.words} {count.label.toLowerCase()}</span
					>{/each}
			</p>
		{/if}
	</ReviewHero>

	{#if review.stale}
		<div data-testid="review-stale">
			<Notice tone="warning" icon="clock" title={review.stale.words}>{review.stale.detail}</Notice>
		</div>
	{/if}

	<div class="sections"><ReviewSections sections={review.sections} {after} /></div>

	{#if review.next}
		{#await card}
			<section class="next" aria-busy="true" data-testid="next-cycle-slot">
				<h3>{review.next.title}</h3>
				{#if review.next.words}<p>{review.next.words}</p>{/if}
			</section>
		{:then { default: NextCycleCard }}
			<NextCycleCard next={review.next} reviewId={review.id} />
		{:catch}
			<section class="next">
				<p>Couldn’t load your next block.</p>
				<Button variant="secondary" icon="refresh" onclick={() => location.reload()}>Retry</Button>
			</section>
		{/await}
	{/if}

	{#if review.history || review.earlier.length}
		<section class="earlier" aria-label="Earlier cycles" data-testid="earlier-cycles">
			{#if review.history}
				<p>
					<Button
						variant="secondary"
						size="sm"
						href={resolve('/(app)/train/history/[[version]]', {
							version: String(review.history.version)
						})}
						data-testid="review-history">{review.history.label}</Button
					>
				</p>
			{/if}
			{@render earlierCycles?.(review.earlier)}
		</section>
	{/if}

	<div class="write-up" data-testid="review-write-up">
		{#if review.writeUp}<p>{review.writeUp}</p>{/if}
	</div>
</article>

<style>
	.pc-cycle-review,
	.earlier,
	.next {
		display: grid;
		gap: var(--space-6);
		min-width: 0;
	}

	.earlier {
		gap: var(--space-3);
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
	}

	th,
	td {
		padding: var(--space-2);
		text-align: start;
		vertical-align: top;
	}

	.sections:empty,
	.write-up:empty {
		display: none;
	}
</style>
