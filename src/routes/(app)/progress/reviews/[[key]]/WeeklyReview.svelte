<!--
  @component
  One weekly review, scannable on an iPhone, every figure from its stored snapshot (load.ts):

  - the hero: the week, the review's one-sentence summary and the adherence meter
  - planned against completed, in words, each count with its canonical value in data-value
  - the trends over the weeks it read, each with its VerdictBadge (a real trend apart from normal
    variation) and its MetricContext (what counts as good, and how it is worked out)
  - RPE, volume and intensity, running, Muay Thai, recovery and fatigue, conflicts and PRs
    (ReviewSections), each collapsing to its verdict line on a phone
  - next week's changes to take, change or skip, or what was decided (NextWeekCard)
  - the coach's write-up, or why there is none, and 'Discuss with your coach' (CoachWriteUp)
  - out of date (training logged since): 'Computed before N later changes', with Refresh while
    its decision is open. Refresh writes the next revision and keeps this one; like Create it is
    busy while it posts (a second tap posts nothing), says why on a failure and resends as
    Retry, and is disabled offline. Without JavaScript the form posts and the page reloads.

  A review written before M6 shows its summary alone.
-->
<script lang="ts">
	import { applyAction, enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { hydrate, onMount, unmount, type Component } from 'svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import ServedInPlace from '../../../today/panels/ServedInPlace.svelte';
	import ServedMarkup from '../../../today/panels/ServedMarkup.svelte';
	import type { WeeklyReviewData } from './load';
	import NextWeekCard from './NextWeekCard.svelte';
	import CoachWriteUp from './CoachWriteUp.svelte';
	import ReviewHero from './ReviewHero.svelte';
	import type { BodyProps } from './review-body';

	interface Props {
		review: WeeklyReviewData;
		/** The body's code, when the load waited for it (+page.ts, review-body.ts). */
		Body?: Component<BodyProps>;
		/** The body's code while the page the server rendered hydrates. */
		body?: Promise<Component<BodyProps>>;
		/** The body as the server rendered it, kept as sent until its code arrives. */
		served?: string;
	}

	let { review, Body, body, served }: Props = $props();

	/** The markup on the server; in the browser, the same element kept as sent (no props). */
	const Held: Component<{ markup: string }> = import.meta.env.SSR
		? ServedMarkup
		: (ServedInPlace as Component<{ markup: string }>);
	let article = $state<HTMLElement>();
	let failed = $state(false);

	// The body the server sent, hydrated in place once its code arrives.
	$effect(() => {
		const target = article?.querySelector(':scope > [data-served]');
		if (!body || !target) return;
		let live: Record<string, unknown> | undefined;
		let gone = false;
		body.then(
			(Live) => {
				if (!gone) live = hydrate(Live, { target, props: { review } });
			},
			() => (failed = true)
		);
		return () => {
			gone = true;
			if (live) unmount(live);
		};
	});
	const adherence = $derived(review.adherence);

	// navigator.onLine read here, as ReviewList does, to keep client/connectivity off this route.
	let online = $state(true);
	onMount(() => (online = navigator.onLine));
	let refreshing = $state<'pending' | 'failed'>();

	/** What the notice says: offline, a failed Refresh, or the server's words (load.ts). */
	const note = $derived(
		!online && review.stale?.refreshable
			? 'You’re offline.'
			: refreshing === 'failed'
				? 'Couldn’t refresh it. Try again.'
				: review.stale?.detail
	);

	const refresh: SubmitFunction = ({ cancel }) => {
		if (refreshing === 'pending' || !online) return cancel();
		refreshing = 'pending';
		return async ({ result }) => {
			// Decided meanwhile (409): reloading shows it as decided, with no Refresh.
			if (result.type === 'redirect' || result.type === 'failure') {
				await (result.type === 'redirect' ? applyAction(result) : invalidateAll());
				refreshing = undefined;
			} else refreshing = 'failed';
		};
	};
</script>

<svelte:window ononline={() => (online = true)} onoffline={() => (online = false)} />

<article
	class="pc-weekly-review"
	aria-labelledby="review-title"
	data-testid="weekly-review"
	bind:this={article}
>
	<ReviewHero
		eyebrow="Weekly review · {review.dates}"
		title={review.title}
		summary={review.summary}
		{adherence}
	/>

	{#if review.stale}
		<form
			class="stale"
			method="POST"
			action="?/refresh"
			use:enhance={refresh}
			data-testid="review-stale"
		>
			<input type="hidden" name="reviewId" value={review.id} />
			<Notice
				tone={refreshing === 'failed' ? 'danger' : 'warning'}
				icon="clock"
				title={review.stale.words}>{note}</Notice
			>
			{#if review.stale.refreshable}
				<Button
					type="submit"
					size="sm"
					variant="secondary"
					icon="refresh"
					loading={refreshing === 'pending'}
					disabled={!online}
					data-testid="review-refresh">{refreshing === 'failed' ? 'Retry' : 'Refresh'}</Button
				>
			{/if}
		</form>
	{/if}

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

	{#if Body}
		<Body {review} />
	{:else if served}
		<Held markup={served} />
	{/if}
	{#if failed && !Body}
		<div class="failed" data-testid="review-body-error">
			<Notice tone="danger" title="Couldn’t load the rest of this review">
				Your training is safe. Check your connection, then try again.
			</Notice>
			<Button variant="secondary" icon="refresh" onclick={() => location.reload()}>Retry</Button>
		</div>
	{/if}

	{#if review.nextWeek}<NextWeekCard next={review.nextWeek} reviewId={review.id} {online} />{/if}

	{#if review.narration}
		<CoachWriteUp narration={review.narration} />
	{/if}
</article>

<style>
	.pc-weekly-review {
		container-type: inline-size;
		display: grid;
		gap: var(--space-6);
		min-width: 0;
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

	.stale,
	.failed {
		display: grid;
		gap: var(--space-3);
		justify-items: start;
	}

	/* A wide enough column: the four counts on one row. */
	@container (width >= 36rem) {
		.counts {
			grid-template-columns: repeat(4, minmax(0, 1fr));
		}
	}
</style>
