<!--
  @component
  One weekly review, scannable on an iPhone, every figure from its stored snapshot (load.ts):

  - the hero: the week, the review's one-sentence summary and the adherence meter
  - planned against completed, in words, each count with its canonical value in data-value
  - the trends over the weeks it read, each with its VerdictBadge (a real trend apart from normal
    variation) and its MetricContext (what counts as good, and how it is worked out)
  - the write-up's slot, empty until the coach writes it (review-narrative-ui)

  A review written before M6 shows its summary alone.
-->
<script lang="ts">
	import MetricContext from '#lib/ui/analytics/MetricContext.svelte';
	import VerdictBadge from '#lib/ui/analytics/VerdictBadge.svelte';
	import type { WeeklyReviewData } from './load';

	interface Props {
		review: WeeklyReviewData;
	}

	let { review }: Props = $props();
	const adherence = $derived(review.adherence);
</script>

<article class="pc-weekly-review" aria-labelledby="review-title" data-testid="weekly-review">
	<header class="hero">
		<p class="eyebrow">Weekly review · {review.dates}</p>
		<h2 id="review-title" tabindex="-1">{review.title}</h2>
		<p class="summary" data-testid="review-summary">{review.summary}</p>
		{#if adherence}
			<div class="meter-row">
				<div
					class="meter"
					role="meter"
					aria-label="Adherence"
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={adherence.pct ?? 0}
					aria-valuetext={adherence.text ?? 'Nothing due'}
					data-level={adherence.level}
					style:--fill="{adherence.pct ?? 0}%"
				>
					<span class="fill"></span>
				</div>
				<p class="pct numeric" data-value={adherence.pct} data-testid="review-adherence">
					{adherence.text ?? '—'}
				</p>
			</div>
		{/if}
	</header>

	{#if adherence}
		<section class="section" aria-labelledby="planned-title">
			<h3 id="planned-title">Planned against completed</h3>
			<p class="words" data-testid="review-adherence-words">{adherence.words}</p>
			<dl class="counts">
				{#each adherence.counts as count (count.label)}
					<div
						class="count"
						data-value={count.value}
						data-testid="review-count-{count.label.toLowerCase()}"
					>
						<dt>{count.label}</dt>
						<dd class="numeric">{count.words}</dd>
					</div>
				{/each}
			</dl>
		</section>
	{/if}

	{#if review.trends.length || review.notes.length}
		<section class="section" aria-labelledby="trends-title">
			<h3 id="trends-title">What is really changing</h3>
			{#each review.notes as note (note.id)}
				<p class="words" data-testid="review-note">{note.words}</p>
			{/each}
			<ul class="trends">
				{#each review.trends as trend (trend.id)}
					<li class="trend" data-testid="review-trend" data-id={trend.id}>
						<div class="trend-head">
							<h4>{trend.label}</h4>
							<VerdictBadge verdict={trend.verdict} />
						</div>
						<p class="words" data-testid="trend-words">
							{trend.words}{trend.change ? ` · ${trend.change} along the trend` : ''}
						</p>
						<MetricContext
							period={trend.context.period}
							comparison={null}
							good={trend.context.good}
							method={trend.context.method}
							caveat={trend.context.caveat}
						/>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<div class="write-up" data-testid="review-write-up">
		{#if review.writeUp}<p>{review.writeUp}</p>{/if}
	</div>
</article>

<style>
	.pc-weekly-review {
		container-type: inline-size;
		display: grid;
		gap: var(--space-6);
		min-width: 0;
	}

	.hero {
		display: grid;
		gap: var(--space-2);
		padding: var(--space-5);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-xl);
		background: var(--color-surface-1);
	}

	.eyebrow {
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
		color: var(--color-text-tertiary);
	}

	h2 {
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-tight);
		line-height: var(--leading-tight);
	}

	h2:focus {
		outline: none;
	}

	.summary {
		max-width: 60ch;
		line-height: var(--leading-normal);
		color: var(--color-text-secondary);
	}

	.meter-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--space-3);
		margin-top: var(--space-2);
	}

	.meter {
		height: 0.5rem;
		overflow: hidden;
		border-radius: var(--radius-full);
		background: var(--color-surface-3);
	}

	.fill {
		display: block;
		width: var(--fill);
		height: 100%;
		border-radius: inherit;
		background: var(--color-text-secondary);
	}

	.meter[data-level='good'] .fill {
		background: var(--color-positive);
	}

	.meter[data-level='watch'] .fill,
	.meter[data-level='low'] .fill {
		background: var(--color-warning);
	}

	.pct {
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
	}

	.section {
		display: grid;
		gap: var(--space-3);
	}

	h3 {
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
	}

	.words {
		line-height: var(--leading-normal);
	}

	.counts {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-2);
		margin: 0;
	}

	.count {
		display: grid;
		gap: var(--space-0-5);
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-lg);
		background: var(--color-surface-1);
	}

	dt {
		font-size: var(--text-xs);
		color: var(--color-text-secondary);
	}

	dd {
		margin: 0;
		font-weight: var(--weight-semibold);
	}

	.trends {
		display: grid;
		gap: var(--space-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.trend {
		display: grid;
		gap: var(--space-2);
		padding: var(--space-4);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
	}

	.trend-head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}

	h4 {
		font-weight: var(--weight-semibold);
	}

	.write-up:empty {
		display: none;
	}

	/* A wide enough column: the four counts on one row. */
	@container (width >= 36rem) {
		.counts {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
	}
</style>
