<!--
  @component
  Progress → Overview: 'am I improving?' at a glance, every number in context (M6).

  - A card per discipline with its verdict in words, the sentence behind it, the weeks it read
    and each piece of evidence with its VerdictBadge.
  - A new owner, or one in their first week, is told so, with what appears and when below.
  - Under them the trends (OverviewTrends): the KPI TrendTiles, the headline charts or the dated
    timeline, in a chunk of their own that loads after hydration, served as static markup until
    it has (trends.ts, TrendsLoader), so only the verdicts' code counts towards initial JS.
  - A container-query grid: the cards pair up once the column is wide enough.
  - When a week or a block completes, its review prompt leads (ReviewPrompt, in a chunk of its
    own, trends.ts): create and open the review, or 'See your review'. The server's markup of it
    (a working form) stays until its code arrives, and stays if that fails.
-->
<script lang="ts">
	import { onMount, type Component } from 'svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import VerdictBadge from '#lib/ui/analytics/VerdictBadge.svelte';
	import type { IconName } from '#lib/ui/icons/icons.ts';
	import type { OverviewData, VerdictCard } from './load';
	import type { ReviewPromptView } from '#lib/ui/analytics/review-prompt.ts';
	import ServedInPlace from '../today/panels/ServedInPlace.svelte';
	import ServedMarkup from '../today/panels/ServedMarkup.svelte';
	import { reviewPrompt } from './trends';
	import TrendsLoader from './TrendsLoader.svelte';

	interface Props {
		overview: OverviewData;
		/** The trends as the server rendered them (+page.ts, trends.ts). */
		served?: string;
		/** The review prompt as the server rendered it (+page.ts, trends.ts). */
		prompt?: string;
	}

	let { overview, served, prompt }: Props = $props();

	/**
	 * The live prompt once its code is in: at once after a client navigation (+page.ts waited for
	 * it), after hydration on the page the server rendered, which shows its markup until then.
	 */
	let loaded = $state.raw<Component<{ review: ReviewPromptView }> | Error>();
	const Prompt = $derived(
		loaded ?? (import.meta.env.SSR || prompt ? undefined : reviewPrompt.settled())
	);
	onMount(() => {
		if (prompt) reviewPrompt.preload().then(() => (loaded = reviewPrompt.settled()));
	});
	const Served: Component<{ markup: string }> = import.meta.env.SSR
		? ServedMarkup
		: (ServedInPlace as Component<{ markup: string }>);

	const context = $derived(
		[overview.context.period, overview.context.comparison, overview.context.trend].filter(
			(part) => part !== null
		)
	);
	const started = $derived(overview.timeline.some((entry) => entry.ready));

	const TONE: Record<VerdictCard['verdict'], 'positive' | 'warning' | 'neutral'> = {
		improving: 'positive',
		holding: 'neutral',
		mixed: 'warning',
		declining: 'warning',
		not_enough_data: 'neutral'
	};
	const ICON: Record<VerdictCard['verdict'], IconName> = {
		improving: 'trend-up',
		holding: 'trend-flat',
		mixed: 'alert',
		declining: 'trend-down',
		not_enough_data: 'clock'
	};
</script>

<div class="pc-overview-view" data-stage={overview.stage} data-testid="overview">
	<!-- If its code fails after a client navigation, the page's Reviews row is the way in. -->
	{#if overview.review}
		{#if Prompt && !(Prompt instanceof Error)}
			<Prompt review={overview.review} />
		{:else if prompt}
			<Served markup={prompt} />
		{/if}
	{/if}
	{#if overview.stage === 'history'}
		<section class="headline" aria-labelledby="overview-headline">
			<p class="eyebrow">Am I improving?</p>
			<h2 id="overview-headline" data-verdict={overview.headline.verdict}>
				{overview.headline.text}
			</h2>
			<p class="context" data-testid="overview-context">{context.join(' · ')}</p>
		</section>
		<ul class="cards">
			{#each overview.cards as card (card.area)}
				<li
					class="card"
					data-area={card.area}
					data-verdict={card.verdict}
					data-testid="verdict-card"
				>
					<div class="card-head">
						<h3>{card.title}</h3>
						<span class="word" data-tone={TONE[card.verdict]}
							><Icon name={ICON[card.verdict]} size={16} strokeWidth={2} />{card.word}</span
						>
					</div>
					<p class="sentence">{card.sentence}</p>
					<p class="window">{card.window}</p>
					{#if card.evidence.length}
						<ul class="evidence">
							{#each card.evidence as item, i (i)}
								<li>
									<span class="subject">{item.subject}</span>
									<VerdictBadge verdict={item.verdict} />
								</li>
							{/each}
						</ul>
					{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<EmptyState
			icon={overview.stage === 'first_week' ? 'sparkle' : 'progress'}
			tone="accent"
			title={overview.stage === 'first_week'
				? 'Your first week is under way'
				: started
					? `Nothing logged in the ${overview.context.period.toLowerCase()}`
					: 'Your progress starts with your first session'}
			description={overview.stage === 'first_week'
				? 'Totals, comparisons and trends count complete weeks, so they start after Sunday. This week so far is below.'
				: 'Log a workout and this page fills in. Here is what appears, and when.'}
			data-testid="overview-intro"
		/>
	{/if}

	<TrendsLoader {overview} {served} />
</div>

<style>
	.pc-overview-view {
		container-type: inline-size;
		display: grid;
		gap: var(--space-6);
		min-width: 0;
	}

	.headline {
		display: grid;
		gap: var(--space-1);
	}

	.eyebrow {
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
		color: var(--color-text-tertiary);
	}

	.headline h2 {
		font-size: var(--text-xl);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-tight);
		line-height: var(--leading-snug);
	}

	.context {
		font-size: var(--text-xs);
		color: var(--color-text-secondary);
	}

	.cards,
	.evidence {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.cards {
		display: grid;
		gap: var(--space-3);
	}

	.card {
		display: grid;
		align-content: start;
		gap: var(--space-2);
		min-width: 0;
		padding: var(--space-4);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background: var(--color-surface-1);
	}

	.card-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}

	.card h3 {
		font-size: var(--text-base);
		font-weight: var(--weight-semibold);
	}

	.word {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		color: var(--word-color, var(--color-text-secondary));
	}

	/* As VerdictBadge: status text darkened in the light theme to keep ≥ 4.5:1. */
	.word[data-tone='positive'] {
		--word-color: light-dark(
			color-mix(in srgb, var(--color-positive) 82%, #000),
			var(--color-positive)
		);
	}

	.word[data-tone='warning'] {
		--word-color: light-dark(
			color-mix(in srgb, var(--color-warning) 82%, #000),
			var(--color-warning)
		);
	}

	.sentence {
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
		color: var(--color-text);
	}

	.window {
		font-size: var(--text-xs);
		color: var(--color-text-tertiary);
	}

	.evidence {
		display: grid;
		gap: var(--space-2);
		padding-top: var(--space-2);
		border-top: 1px solid var(--color-hairline);
	}

	.evidence li {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-1) var(--space-2);
	}

	.subject {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	/* A wide column (a desktop window): the cards pair up. */
	@container (width >= 44rem) {
		.cards {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
</style>
