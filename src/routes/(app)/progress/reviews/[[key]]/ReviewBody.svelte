<!--
  @component
  The weekly review under planned against completed (WeeklyReview), in a chunk of its own that
  loads after hydration (review-body.ts): the server sends it as static markup, which the page
  keeps and hydrates in place, so first paint and no-JS never wait for it, and only the hero's,
  Refresh's and the counts' code counts towards initial JS.

  - The trends over the weeks it read, each with its VerdictBadge (a real trend apart from normal
    variation) and its MetricContext (what counts as good, and how it is worked out).
  - RPE, volume and intensity, running, Muay Thai, recovery and fatigue, conflicts and PRs
    (ReviewSections), each collapsing to its verdict line on a phone.

  Its parts are rows of the review's grid, as if WeeklyReview rendered them itself.
-->
<script lang="ts">
	import MetricContext from '#lib/ui/analytics/MetricContext.svelte';
	import VerdictBadge from '#lib/ui/analytics/VerdictBadge.svelte';
	import type { BodyProps } from './review-body';
	import ReviewSections from './ReviewSections.svelte';

	let { review }: BodyProps = $props();
</script>

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

<div class="sections"><ReviewSections sections={review.sections} /></div>

<style>
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

	.sections:empty {
		display: none;
	}
</style>
