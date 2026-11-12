<!--
  @component
  A review's hero, shared by the weekly and the cycle review so its styles ship once: the period,
  the title (focused on a phone when the review opens), the one-sentence summary and the adherence
  meter, with anything after it (the cycle review's counts) as children.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { FindingLevel } from '#lib/domain/programming/review/brief.ts';

	interface Props {
		eyebrow: string;
		title: string;
		summary: string;
		adherence: { pct: number | null; text: string | null; level: FindingLevel } | null;
		children?: Snippet;
	}

	let { eyebrow, title, summary, adherence, children }: Props = $props();
</script>

<header class="hero">
	<p class="eyebrow">{eyebrow}</p>
	<h2 id="review-title" tabindex="-1">{title}</h2>
	<p class="summary" data-testid="review-summary">{summary}</p>
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
	{@render children?.()}
</header>

<style>
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
</style>
