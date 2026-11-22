<!--
  @component
  Train's program header: the program's title, the block and where the week shown sits in it
  ('Baseline week · Week 1 of 5'), the week's findings in one line under it ('1 heads-up this
  week'; the caller leaves it out where it would mislead), an optional status as a badge
  ('Starts Mon 9 Nov'),
  and the weeks as numbered pills between previous and next. Each is a link the caller resolved,
  so changing week is a navigation the server renders: it replaces the history entry and keeps
  the scroll position and the focus (data-sveltekit-replacestate and -reset="false" on the nav). The
  week shown is the current page, this week is ringed (as WeekStrip rings today), and the week
  `pending` names is busy while it loads. Pills scroll sideways inside their row when a plan has
  more weeks than fit; the screen itself never does. Every target is ≥ 44 px.

  `actions`, a row under the titles, holds the program's own screens and sheets ('Plan', then
  'History'): each a `.action` the caller renders (a button or a link), styled here alike, and
  busy (`aria-busy`) while what it opens is on its way.

  In a wide column (WIDE_HEADER below, a desktop screen's width) the actions sit at the end of the
  titles' row and the weeks run from the start under them, instead of three stacked rows.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import Badge from '../components/Badge.svelte';
	import Icon from '../components/Icon.svelte';
	import type { IconName } from '../icons/icons';

	interface Props {
		title: string;
		/** The block's name and the week's place: 'Baseline week · Week 1 of 5'. */
		position: string;
		/** The planned weeks' pills, by number from 1, each with its resolved link. */
		weeks: readonly { number: number; href: string }[];
		/** The number of the week shown. */
		shown: number;
		/** The number of the week that holds today, if it is planned. */
		current: number | null;
		/** The number of the week loading, while it does. */
		pending?: number | null;
		/** Links to the weeks either side, when there is one. */
		previous?: string;
		next?: string;
		/** A status in words beside the position, e.g. 'Starts Mon 9 Nov'. */
		status?: string | null;
		/** The week's findings in one line, under the position: '1 heads-up this week'. */
		line?: string | null;
		/** The actions row: `.action` buttons or links, and any notice about them. */
		actions?: Snippet;
	}

	let {
		title,
		position,
		weeks,
		shown,
		current,
		pending = null,
		previous,
		next,
		status,
		line,
		actions
	}: Props = $props();
	const id = $props.id();
</script>

{#snippet step(href: string | undefined, label: string, icon: IconName, testId: string)}
	<!-- Without a week that side, a placeholder keeps the pills where they are. -->
	{#if href}
		<a class="step" {href} aria-label={label} data-testid={testId}>
			<Icon name={icon} size={20} />
		</a>
	{:else}
		<span class="step" aria-hidden="true"><Icon name={icon} size={20} /></span>
	{/if}
{/snippet}

<header class="program" aria-labelledby={id} data-testid="program-header">
	<div class="titles">
		<h2 {id} class="title">{title}</h2>
		<p class="position" data-testid="program-position">{position}</p>
		<!-- Always in the markup, hidden while empty: no week line adds no block. -->
		<p class="position" data-testid="week-line">{line}</p>
		{#if status}
			<p class="status"><Badge icon="clock" data-testid="program-status">{status}</Badge></p>
		{/if}
	</div>
	{#if actions}<div class="actions">{@render actions()}</div>{/if}
	<nav class="weeks" aria-label="Weeks" data-sveltekit-replacestate data-sveltekit-reset="false">
		{@render step(previous, 'Previous week', 'chevron-left', 'previous-week')}
		<ol class="pills">
			{#each weeks as week (week.number)}
				<li>
					<a
						class="pill numeric"
						href={week.href}
						aria-label={`Week ${week.number}${week.number === current ? ', this week' : ''}`}
						aria-current={week.number === shown ? 'page' : undefined}
						aria-busy={week.number === pending ? 'true' : undefined}
						data-this-week={week.number === current ? '' : undefined}>{week.number}</a
					>
				</li>
			{/each}
		</ol>
		{@render step(next, 'Next week', 'chevron-right', 'next-week')}
	</nav>
</header>

<style>
	/* Two columns, the second empty (0 px) until the header is wide: every row spans both. */
	.program {
		container-type: inline-size;
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: var(--space-3);
	}

	.titles,
	.actions,
	.weeks {
		grid-column: 1 / -1;
	}

	.titles {
		display: grid;
		gap: var(--space-1);
		min-width: 0;
	}

	.title {
		font-family: var(--font-display);
		font-size: var(--text-xl);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-tight);
		line-height: var(--leading-snug);
		overflow-wrap: anywhere;
	}

	.position {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.position:empty {
		display: none;
	}

	.status {
		margin-top: var(--space-1);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	/* An action: a quiet outlined pill, icon then word, 44 px tall. Busy, a spinner takes the
	   icon's place after a beat, so a fast load shows nothing. */
	.actions :global(.action) {
		position: relative;
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		min-height: var(--touch-target);
		padding: 0 var(--space-4) 0 var(--space-3);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-full);
		background: var(--color-surface-1);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		color: var(--color-text);
		transition:
			border-color var(--duration-fast) var(--ease-standard),
			transform var(--duration-fast) var(--ease-out);
	}

	.actions :global(.action[aria-busy='true'] svg) {
		animation: shown 0s 150ms reverse forwards;
	}

	.actions :global(.action[aria-busy='true'])::before {
		content: '';
		position: absolute;
		top: 50%;
		left: calc(var(--space-3) + 1px);
		width: 16px;
		height: 16px;
		margin-top: -8px;
		border: 2px solid color-mix(in srgb, currentColor 25%, transparent);
		border-top-color: currentColor;
		border-radius: var(--radius-full);
		opacity: 0;
		animation:
			shown 0s 150ms forwards,
			spin 0.8s linear infinite;
	}

	@keyframes shown {
		from {
			opacity: 0;
		}
		to {
			opacity: 1;
		}
	}

	.weeks {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--space-1);
	}

	.pills {
		display: flex;
		gap: var(--space-1);
		margin: 0;
		padding: 2px;
		overflow-x: auto;
		overscroll-behavior-x: contain;
		scrollbar-width: none;
		list-style: none;
	}

	.step,
	.pill {
		position: relative;
		display: grid;
		flex: none;
		place-items: center;
		min-width: var(--touch-target);
		height: var(--touch-target);
		border: 1px solid transparent;
		border-radius: var(--radius-full);
		color: var(--color-text-secondary);
		transition:
			background-color var(--duration-fast) var(--ease-standard),
			border-color var(--duration-fast) var(--ease-standard),
			transform var(--duration-fast) var(--ease-out);
	}

	.pill {
		font-weight: var(--weight-semibold);
	}

	span.step {
		color: var(--color-text-disabled);
	}

	a.step {
		color: var(--color-text);
	}

	.pill[aria-current='page'] {
		color: var(--color-text);
		background: var(--color-surface-1);
		border-color: var(--color-border);
		box-shadow: var(--elevation-1);
	}

	/* This week: a ring, as WeekStrip rings today; words say it too. */
	.pill[data-this-week] {
		box-shadow: inset 0 0 0 1.5px var(--color-accent-text);
	}

	.pill[aria-current='page'][data-this-week] {
		box-shadow:
			inset 0 0 0 1.5px var(--color-accent-text),
			var(--elevation-1);
	}

	@media (hover: hover) and (pointer: fine) {
		a.step:hover,
		.pill:hover,
		.actions :global(.action:hover) {
			border-color: var(--color-border-strong);
		}
	}

	a.step:active,
	.pill:active,
	.actions :global(.action:active) {
		transform: scale(0.94);
	}

	.step:focus-visible,
	.pill:focus-visible,
	.actions :global(.action:focus-visible) {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: -2px;
	}

	/* Loading: a ring sweeps round the pill, still under reduced motion. */
	.pill[aria-busy='true']::after {
		content: '';
		position: absolute;
		inset: -1px;
		border: 2px solid transparent;
		border-top-color: var(--color-accent-text);
		border-radius: inherit;
		animation: spin 0.8s linear infinite;
	}

	/*
	 * WIDE_HEADER: from 48rem, well above the phone (34rem) and readable (40rem) columns, so only a
	 * desktop screen's full width sees it. The actions take the end of the titles' row (a failure
	 * notice wraps under them, at most 24rem wide), and the weeks run from the start.
	 */
	@container (min-width: 48rem) {
		.titles {
			grid-column: 1;
		}

		.actions {
			grid-column: 2;
			justify-content: flex-end;
			align-self: start;
			max-width: 24rem;
		}

		.weeks {
			grid-template-columns: auto minmax(0, max-content) auto;
			justify-content: start;
			margin-top: var(--space-2);
		}
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.pill[aria-busy='true']::after {
			animation: none;
		}
	}
</style>
