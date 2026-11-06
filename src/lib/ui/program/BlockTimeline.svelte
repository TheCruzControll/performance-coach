<!--
  @component
  The plan as a timeline, in timeline.ts's words: each block on a rail (the block holding this
  week marked, an outline block dashed) with its name, phase, dates and length, then its weeks.
  The week that holds today says 'This week', a dated goal sits under its week as an 'Event',
  and an outline week says 'Not planned yet' and is never a link. With `weekHref`, each planned
  week is a link to it (≥ 44 px) and `onweek` hears the tap first; without it (a preview) no week
  is a link.
-->
<script lang="ts">
	import Badge from '../components/Badge.svelte';
	import Icon from '../components/Icon.svelte';
	import type { TimelineBlock, TimelineWeek } from './timeline.ts';

	interface Props {
		blocks: readonly TimelineBlock[];
		/** A planned week's link, by its number. */
		weekHref?: (week: number) => string;
		/** A tap on a week's link, before the browser follows it (it may prevent that). */
		onweek?: (event: MouseEvent, week: number) => void;
		'data-testid'?: string;
	}

	let { blocks, weekHref, onweek, 'data-testid': testId }: Props = $props();
</script>

{#snippet row(week: TimelineWeek)}
	<span class="label">
		<span class="number">Week {week.number}</span>
		<span class="dates">{week.dates}</span>
	</span>
	{#if week.current}<Badge tone="accent">This week</Badge>{/if}
	{#if !week.planned}<span class="later">Not planned yet</span>{/if}
{/snippet}

<ol class="timeline" data-testid={testId}>
	{#each blocks as block (block.key)}
		<li
			class="block"
			data-outline={block.outline ? '' : undefined}
			data-current={block.current ? '' : undefined}
			data-testid="plan-block"
		>
			<div class="head">
				<h3 class="name">{block.name}</h3>
				{#if block.outline}<Badge>Outline</Badge>{/if}
				<p class="span" data-testid="plan-block-span">
					{#if block.phase}{block.phase} ·
					{/if}{block.span}
				</p>
			</div>
			<ol class="weeks">
				{#each block.weeks as week (week.number)}
					{@const href = week.planned ? weekHref?.(week.number) : undefined}
					<li>
						{#if href}
							<a
								class="week"
								{href}
								aria-current={week.current ? 'date' : undefined}
								onclick={(event) => onweek?.(event, week.number)}
								data-testid="plan-week"
							>
								{@render row(week)}
								<span class="chevron"><Icon name="chevron-right" size={18} /></span>
							</a>
						{:else}
							<div
								class="week"
								aria-current={week.current ? 'date' : undefined}
								data-testid="plan-week"
							>
								{@render row(week)}
							</div>
						{/if}
						{#each week.events as event, i (i)}
							<p class="event" data-testid="plan-event">
								<Badge tone="accent" icon="target">Event</Badge>
								<span class="event-title">{event.title}</span>
								<span class="event-date">{event.date}</span>
							</p>
						{/each}
					</li>
				{/each}
			</ol>
		</li>
	{/each}
</ol>

<style>
	.timeline,
	.weeks {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.timeline {
		display: grid;
		gap: var(--space-6);
	}

	/* The rail: a node per block and a line down to the next one, dashed through the outline. */
	.block {
		--node: var(--color-text-tertiary);
		--rail: var(--color-border-strong);
		position: relative;
		display: grid;
		gap: var(--space-3);
		padding-left: var(--space-6);
	}

	.block::before {
		content: '';
		position: absolute;
		top: 1.375rem;
		bottom: calc(var(--space-6) * -1);
		left: 6px;
		width: 2px;
		background: var(--rail);
	}

	.block:last-child::before {
		bottom: 0;
	}

	.block::after {
		content: '';
		position: absolute;
		top: 0.375rem;
		left: 0;
		width: 14px;
		height: 14px;
		border: 2px solid var(--node);
		border-radius: var(--radius-full);
		background: var(--color-surface-1);
	}

	.block[data-current] {
		--node: var(--color-accent-text);
	}

	.block[data-current]::after {
		background: var(--node);
		box-shadow: 0 0 0 4px var(--color-accent-subtle);
	}

	.block[data-outline]::before {
		background: repeating-linear-gradient(var(--rail) 0 4px, transparent 4px 8px);
	}

	.block[data-outline]:not([data-current])::after {
		border-style: dashed;
	}

	.head {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1) var(--space-2);
		min-width: 0;
	}

	.name {
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-tight);
		line-height: var(--leading-snug);
		overflow-wrap: anywhere;
	}

	.span {
		flex-basis: 100%;
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	/* The weeks: one grouped list, hairlines between rows; dashed and unfilled in the outline. */
	.weeks {
		overflow: hidden;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background: var(--color-surface-2);
	}

	.block[data-outline] .weeks {
		border-style: dashed;
		background: transparent;
	}

	.weeks > li + li {
		border-top: 1px solid var(--color-border);
	}

	.week {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		min-height: 3.25rem;
		padding: var(--space-2) var(--space-3) var(--space-2) var(--space-4);
		color: var(--color-text);
		transition: background-color var(--duration-fast) var(--ease-standard);
	}

	.label {
		display: grid;
		flex: 1;
		min-width: 0;
	}

	.number {
		font-weight: var(--weight-semibold);
	}

	.block[data-outline] .number {
		color: var(--color-text-secondary);
	}

	.dates,
	.later {
		font-size: var(--text-xs);
		color: var(--color-text-secondary);
	}

	.later {
		flex: none;
	}

	.chevron {
		display: grid;
		flex: none;
		color: var(--color-text-tertiary);
	}

	a.week:active {
		background: var(--color-surface-3);
	}

	@media (hover: hover) and (pointer: fine) {
		a.week:hover {
			background: var(--color-surface-3);
		}
	}

	a.week:focus-visible {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: -2px;
		border-radius: inherit;
	}

	/* A dated goal: under its week, tinted, its words before its colour. */
	.event {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1) var(--space-2);
		padding: var(--space-2) var(--space-4) var(--space-3);
		font-size: var(--text-sm);
	}

	.event-title {
		font-weight: var(--weight-semibold);
		overflow-wrap: anywhere;
	}

	.event-date {
		color: var(--color-text-secondary);
	}
</style>
