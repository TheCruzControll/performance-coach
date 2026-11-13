<!--
  @component
  The plan as a timeline, in timeline.ts's words: each block on a rail (the block holding this
  week marked, an outline block dashed) with its name, phase, dates and length, then its weeks.
  The week that holds today says 'This week', a dated goal sits under its week as an 'Event',
  and an outline week says 'Not planned yet' and is never a link. A bridge between blocks (a late
  start's unplanned weeks) is hatched, its weeks 'Unplanned'. With `weekHref`, each planned
  week is a link to it (≥ 44 px) and `onweek` hears the tap first; without it (a preview) no week
  is a link.

  With `season` (Train's plan sheet, m7/39; season.ts), every block from this one on names each
  goal's role ('Marathon · secondary', the leader first), its phase tone colours its node beside
  its name, its deload, taper and recovery weeks carry the word, this week is ringed, and a long
  run of outline weeks is one counted row. From 1024 px a segmented track (aria-hidden: the list
  is its twin) runs above with the events and today on it. While the season streams (null, with
  `lanes` goals) each block holds its lanes' room (the goals and a caption) and the track its own,
  so the swap moves nothing (no lanes' room with no goals). Without `season` (also once it
  failed), none of this renders.
-->
<script lang="ts">
	import Badge from '../components/Badge.svelte';
	import Icon from '../components/Icon.svelte';
	import type { SeasonView } from './season.ts';
	import type { TimelineBlock } from './timeline.ts';
	import { weekRows, type WeekRow } from './week-rows.ts';

	interface Props {
		blocks: readonly TimelineBlock[];
		/** A planned week's link, by its number. */
		weekHref?: (week: number) => string;
		/** A tap on a week's link, before the browser follows it (it may prevent that). */
		onweek?: (event: MouseEvent, week: number) => void;
		/** The season over the blocks; null while it streams. */
		season?: SeasonView | null;
		/**
		 * The goals each block's lanes list, their room held while the season streams. The owner's
		 * open goals now: a block planned with more goals than that grows when its lanes land (rare).
		 */
		lanes?: number;
		'data-testid'?: string;
	}

	let { blocks, weekHref, onweek, season, lanes = 0, 'data-testid': testId }: Props = $props();

	const seasonal = $derived(season !== undefined);
	const byKey = $derived(new Map(season?.blocks.map((b) => [b.key, b])));
	/** This block on: the blocks the season covers (all of them before the program starts). */
	const ahead = $derived(
		Math.max(
			0,
			blocks.findIndex((b) => b.current)
		)
	);
</script>

{#snippet row(week: WeekRow['week'], bridge: boolean, tick: string)}
	<span class="label">
		<span class="number"
			>{week.last ? `Weeks ${week.number}–${week.last}` : `Week ${week.number}`}{#if tick}<span
					class="tick">{tick}</span
				>{/if}</span
		>
		<span class="dates">{week.dates}</span>
	</span>
	{#if week.current}<Badge tone="accent">This week</Badge>{/if}
	{#if !week.planned}<span class="later">{week.count ? `${week.count} · ` : ''}Not planned yet</span
		>{/if}
	{#if bridge}<span class="later">Unplanned</span>{/if}
{/snippet}

{#if seasonal}
	<div class="track" aria-hidden="true">
		{#if season}
			<div class="bar">
				{#each season.blocks as segment (segment.key)}
					<span
						class="segment"
						data-tone={segment.tone}
						data-outline={segment.outline ? '' : undefined}
						data-label={segment.label}
						style:flex-grow={segment.weeks}
					></span>
				{/each}
				{#each season.marks as mark, i (i)}<span
						class="mark"
						data-kind={mark.kind}
						style:left="{mark.at}%"
					></span>{/each}
			</div>
			<p class="legend">{season.legend}</p>
		{/if}
	</div>
{/if}

<ol class="timeline" class:seasonal data-testid={testId}>
	{#each blocks as block, b (block.key)}
		{@const over = byKey.get(block.key)}
		{@const reserve =
			seasonal && !block.bridge && b >= ahead && (season ? !!over?.lanes.length : lanes > 0)}
		<li
			class="block"
			data-outline={block.outline ? '' : undefined}
			data-bridge={block.bridge ? '' : undefined}
			data-current={block.current ? '' : undefined}
			data-tone={over?.tone}
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
			{#if reserve}
				<div class="lanes" style:--lines={lanes + 1}>
					{#if over?.lanes.length}
						<p class="caption">
							{season?.note ? `Goal roles · ${season.note}` : 'Goal roles'}
						</p>
						<ul>
							{#each over.lanes as lane, i (i)}
								<li data-lead={lane.lead ? '' : undefined}>
									<span class="goal">{lane.goal}</span><span class="role"> · {lane.role}</span>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			{/if}
			<ol class="weeks">
				{#each weekRows( block.weeks, { outline: block.outline, collapse: seasonal, ticks: over?.ticks } ) as { week, tick } (week.number)}
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
								{@render row(week, block.bridge, tick)}
								<span class="chevron"><Icon name="chevron-right" size={18} /></span>
							</a>
						{:else}
							<div
								class="week"
								aria-current={week.current ? 'date' : undefined}
								data-testid={week.last ? 'plan-weeks' : 'plan-week'}
							>
								{@render row(week, block.bridge, tick)}
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

	/* A bridge: hatched, a gap in the plan rather than weeks of it. */
	.block[data-bridge] .weeks {
		background: repeating-linear-gradient(
			-45deg,
			var(--color-surface-2) 0 6px,
			var(--color-surface-1) 6px 12px
		);
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

	/* ---- The season (m7/39): only with `season`. ---------------------------------------- */

	/* A phase tone colours the node beside the block's name; this block's node stays the accent. */
	.block[data-tone='build']:not([data-current]) {
		--node: var(--color-info);
	}

	.block[data-tone='peak']:not([data-current]) {
		--node: var(--color-strength);
	}

	.block[data-tone='taper']:not([data-current]) {
		--node: var(--color-conditioning);
	}

	.block[data-tone='recovery']:not([data-current]) {
		--node: var(--color-positive);
	}

	/* The goals' lanes: fixed-height lines, their room held from the goal count while it streams. */
	.lanes {
		--lane: 1.375rem;
		min-height: calc(var(--lines) * var(--lane));
		font-size: var(--text-sm);
		line-height: var(--lane);
	}

	.lanes ul {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.caption,
	.lanes li {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.caption {
		font-size: var(--text-xs);
		color: var(--color-text-secondary);
	}

	.lanes li[data-lead] .goal {
		font-weight: var(--weight-semibold);
	}

	.role {
		color: var(--color-text-secondary);
	}

	/* A deload, taper or recovery week: its word after its number, on the number's one line. */
	.seasonal .number {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.tick {
		margin-left: var(--space-2);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
	}

	.tick::before {
		content: '';
		display: inline-block;
		width: 2px;
		height: 0.75em;
		margin-right: var(--space-1);
		vertical-align: -0.05em;
		background: var(--color-border-strong);
	}

	/* This week: ringed inside its row. */
	.seasonal .week[aria-current] {
		box-shadow: inset 0 0 0 2px var(--color-accent-ring);
	}

	/* The track: a desktop window only; its room is held while the season streams. */
	.track {
		display: none;
	}

	@media (width >= 64rem) {
		.track {
			display: grid;
			gap: var(--space-2);
			align-content: start;
			height: 4.5rem;
			margin-bottom: var(--space-6);
			font-size: var(--text-xs);
			color: var(--color-text-secondary);
		}
	}

	.bar {
		position: relative;
		display: flex;
		padding-top: var(--space-2);
	}

	.segment {
		--tone: var(--color-info);
		display: grid;
		flex: 1 1 0;
		gap: var(--space-1);
		min-width: 0;
	}

	.segment::before {
		content: '';
		height: 0.5rem;
		border-radius: var(--radius-full);
		margin-right: 2px;
		background: color-mix(in oklab, var(--tone) 55%, transparent);
	}

	.segment::after {
		content: attr(data-label);
	}

	.segment[data-outline]::before {
		background: repeating-linear-gradient(
			-45deg,
			color-mix(in oklab, var(--tone) 45%, transparent) 0 4px,
			transparent 4px 7px
		);
	}

	.segment[data-tone='peak'] {
		--tone: var(--color-strength);
	}

	.segment[data-tone='taper'] {
		--tone: var(--color-conditioning);
	}

	.segment[data-tone='recovery'] {
		--tone: var(--color-positive);
	}

	.segment[data-tone='maintenance'],
	.segment[data-tone='bridge'] {
		--tone: var(--color-text-tertiary);
	}

	.segment::after,
	.legend {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	.mark {
		position: absolute;
		top: 0;
		width: 2px;
		height: 1.25rem;
		translate: -50% 0;
		background: var(--color-text-tertiary);
	}

	.mark:not([data-kind='tick']) {
		top: 1px;
		width: 0.625rem;
		height: 0.625rem;
		border-radius: var(--radius-full);
	}

	.mark[data-kind='pin'] {
		rotate: 45deg;
		border-radius: 2px;
		background: var(--color-text);
	}

	.mark[data-kind='now'] {
		box-shadow: 0 0 0 2px var(--color-accent-ring);
		background: var(--color-surface-1);
	}
</style>
