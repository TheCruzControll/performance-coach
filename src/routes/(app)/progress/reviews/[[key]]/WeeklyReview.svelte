<!--
  @component
  One weekly review, scannable on an iPhone, every figure from its stored snapshot (load.ts):

  - the hero: the week, the review's one-sentence summary and the adherence meter
  - planned against completed, in words, each count with its canonical value in data-value
  - the trends and the sections (ReviewBody), in a chunk of their own: on the page the server
    rendered, their markup is kept as sent and hydrated in place once their code arrives
    (review-body.ts), so nothing is replaced and a section opened meanwhile stays open. If the
    code fails to load, they read as sent, with a notice and Retry, which reloads: Chromium keeps
    a failed module fetch for the document's lifetime.
  - the write-up's slot, empty until the coach writes it (review-narrative-ui)
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

	.stale,
	.failed {
		display: grid;
		gap: var(--space-3);
		justify-items: start;
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
