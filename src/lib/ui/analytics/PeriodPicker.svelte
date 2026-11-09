<!--
  @component
  The period switch over a set of figures: five real links to ?period= (4w, 12w, 26w, 52w, All),
  the current one marked with aria-current, and the content they switch below them.

  - Links, not buttons: a switch works without JavaScript, and each one is a history entry, so
    Back returns to the previous period. With JavaScript, SvelteKit keeps the scroll position and
    the focus on the link (data-sveltekit-reset="false").
  - Each link is at least 44 px tall and wide at 320 px.
  - While another period loads, the content holds its frame at reduced opacity with aria-busy and
    no skeleton, so the numbers never jump to placeholders and back; a fast switch shows nothing.
    The dimmed figures are inert until the new ones arrive: inactive, so stale numbers are not
    acted on (and, as inactive content, exempt from the text contrast minimum).
    Busy is read from SvelteKit's navigation (this page, another ?period), or given as `busy`.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { navigating, page } from '$app/state';
	import {
		PERIOD_LABEL,
		PERIODS,
		parsePeriod,
		type Period
	} from '#lib/domain/analytics/periods.ts';

	interface Props {
		current: Period;
		/** The nav's accessible name. */
		label?: string;
		/** Forces the loading state; by default it follows SvelteKit's navigation. */
		busy?: boolean;
		'data-testid'?: string;
		children: Snippet;
	}

	let { current, label = 'Period', busy, children, ...rest }: Props = $props();

	/** What each link shows; its accessible name is the full PERIOD_LABEL ('Last 4 weeks'). */
	const SHORT: Readonly<Record<Period, string>> = {
		'4w': '4w',
		'12w': '12w',
		'26w': '26w',
		'52w': '52w',
		all: 'All'
	};

	const loading = $derived(
		busy ??
			(navigating.to?.url.pathname === page.url.pathname &&
				parsePeriod(navigating.to.url.searchParams.get('period')) !== current)
	);
</script>

<div class="period-view" {...rest}>
	<nav class="picker" aria-label={label} data-sveltekit-reset="false">
		<ul>
			{#each PERIODS as period (period)}
				<li>
					<a
						class="period numeric"
						href="?period={period}"
						aria-current={period === current ? 'page' : undefined}
						><span aria-hidden="true">{SHORT[period]}</span><span class="visually-hidden"
							>{PERIOD_LABEL[period]}</span
						></a
					>
				</li>
			{/each}
		</ul>
	</nav>
	<p class="visually-hidden" role="status">{loading ? 'Loading the period…' : ''}</p>
	<div class="content" inert={loading} aria-busy={loading} data-testid="period-content">
		{@render children()}
	</div>
</div>

<style>
	.period-view {
		display: grid;
		gap: var(--space-4);
		min-width: 0;
	}

	.picker ul {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		gap: var(--space-0-5);
		padding: 3px;
		margin: 0;
		list-style: none;
		border-radius: var(--radius-full);
		background: var(--color-surface-2);
		border: 1px solid var(--color-border);
	}

	.period {
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: var(--touch-target);
		min-height: var(--touch-target);
		border-radius: var(--radius-full);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		color: var(--color-text-secondary);
		text-decoration: none;
		transition:
			background-color var(--duration-fast) var(--ease-standard),
			color var(--duration-fast) var(--ease-standard);
	}

	.period[aria-current='page'] {
		background: var(--color-surface-inverse);
		color: var(--color-text-inverse);
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.25);
	}

	.period:focus-visible {
		outline-offset: 1px;
		border-radius: var(--radius-full);
	}

	.period:not([aria-current='page']):active {
		background: var(--color-surface-3);
	}

	@media (hover: hover) and (pointer: fine) {
		.period:not([aria-current='page']):hover {
			background: var(--color-surface-3);
			color: var(--color-text);
		}
	}

	/* Another period on its way: the figures stay where they are, dimmed, after a beat. */
	.content {
		min-width: 0;
		transition: opacity var(--duration-base) var(--ease-standard);
	}

	.content[aria-busy='true'] {
		opacity: 0.55;
		transition-delay: 150ms;
	}
</style>
