<!--
  @component
  Train's program header: the program's title, the block and where the week shown sits in it
  ('Baseline week · Week 1 of 5'), an optional status as a badge ('Starts Mon 9 Nov'),
  and the weeks as numbered pills between previous and next. Each is a link the caller resolved,
  so changing week is a navigation the server renders: it replaces the history entry and keeps
  the scroll position and the focus (data-sveltekit-replacestate and -reset="false" on the nav). The
  week shown is the current page, this week is ringed (as WeekStrip rings today), and the week
  `pending` names is busy while it loads. Pills scroll sideways inside their row when a plan has
  more weeks than fit; the screen itself never does. Every target is ≥ 44 px.
-->
<script lang="ts">
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
		status
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
		{#if status}
			<p class="status"><Badge icon="clock" data-testid="program-status">{status}</Badge></p>
		{/if}
	</div>
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
	.program {
		display: grid;
		gap: var(--space-3);
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

	.status {
		margin-top: var(--space-1);
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
		.pill:hover {
			border-color: var(--color-border-strong);
		}
	}

	a.step:active,
	.pill:active {
		transform: scale(0.94);
	}

	.step:focus-visible,
	.pill:focus-visible {
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
