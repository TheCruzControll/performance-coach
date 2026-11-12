<!--
  @component
  One metric with its context at a glance (M6): its label and value with its unit, an Estimated
  or Measured badge, the change against the named previous period (an icon that follows better
  and a word, toned by direction × good, neutral when the trend calls it normal variation) or,
  with no earlier period, the trend within its own weeks read from the same verdict, the week so
  far against the same days of last week, a static sparkline and the trend verdict with its
  window.

  - The server sends every number formatted and the sparkline computed (sparkline.ts), so a tile
    costs no chart code; the polyline is stretched over its box with a non-scaling 2 px stroke.
  - A screen reader hears the tile as one sentence (words.ts tileSentence); the visible parts are
    hidden from it, so nothing is read twice or out of order.
  - Stat's contract: no value is a quiet dash and 'No data yet', never an invented number.
  - `data-value` holds the canonical number, for specs and the coach's parity checks.
-->
<script lang="ts">
	import Badge from '../components/Badge.svelte';
	import Icon from '../components/Icon.svelte';
	import VerdictBadge from './VerdictBadge.svelte';
	import {
		deltaIcon,
		deltaTone,
		CHANGE_WORDS,
		KIND_WORD,
		NO_COMPARISON,
		soFarWords,
		tileSentence,
		withinWords,
		type Tile
	} from './words.ts';

	interface Props {
		tile: Tile;
		as?: 'div' | 'li';
		'data-testid'?: string;
	}

	let { tile, as = 'div', ...rest }: Props = $props();

	const empty = $derived(tile.value === null);
	/** With no earlier period: the trend within the tile's own weeks, from its verdict. */
	const within = $derived(withinWords(tile.verdict, tile.window));
	const shape = $derived(
		tile.kind === 'estimated' ? 'ring' : tile.kind === 'measured' ? 'diamond' : 'dot'
	);
</script>

<svelte:element
	this={as}
	class="tile"
	data-value={tile.canonical ?? undefined}
	data-kind={tile.kind}
	{...rest}
>
	<p class="visually-hidden" data-testid="tile-sentence">{tileSentence(tile)}</p>
	<div class="face" aria-hidden="true">
		<div class="head">
			<span class="label">{tile.label}</span>
			<Badge>{KIND_WORD[tile.kind]}</Badge>
		</div>
		<div class="main">
			<span class="value numeric" class:empty>
				{#if tile.value === null}—{:else}{tile.value}{#if tile.unit}<span class="unit"
							>{tile.unit}</span
						>{/if}{/if}
			</span>
			{#if tile.sparkline && !empty}
				<span class="spark" data-testid="sparkline">
					<svg viewBox="0 0 100 100" preserveAspectRatio="none" focusable="false">
						<polyline points={tile.sparkline.points} />
					</svg>
					<span
						class="end"
						data-shape={shape}
						style:left="{tile.sparkline.end.x}%"
						style:top="{tile.sparkline.end.y}%"
					></span>
				</span>
			{/if}
		</div>
		{#if empty}
			<p class="line quiet">No data yet</p>
		{:else if tile.delta}
			<p class="line delta" data-tone={deltaTone(tile.delta, tile.verdict)} data-testid="delta">
				<span class="glyph"><Icon name={deltaIcon(tile.delta)} size={16} strokeWidth={2} /></span>
				<span
					><strong class="numeric">{tile.delta.text}</strong>
					{CHANGE_WORDS[tile.delta.change]}
					{tile.delta.against}</span
				>
			</p>
		{:else if within}
			<p class="line" data-testid="delta">{within}</p>
		{:else}
			<p class="line quiet" data-testid="delta">{NO_COMPARISON}</p>
		{/if}
		{#if tile.soFar}
			<p class="line so-far" data-testid="so-far">{soFarWords(tile.soFar)}</p>
		{/if}
		{#if tile.verdict}
			<VerdictBadge verdict={tile.verdict} window={tile.window} />
		{/if}
	</div>
</svelte:element>

<style>
	.tile {
		container-type: inline-size;
		min-width: 0;
		padding: var(--space-4);
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-border);
		background: var(--color-surface-1);
		box-shadow: var(--elevation-1);
	}

	.face {
		display: grid;
		align-content: start;
		gap: var(--space-2);
	}

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		min-width: 0;
	}

	.label {
		min-width: 0;
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
	}

	.main {
		display: grid;
		grid-template-columns: minmax(0, 1fr) 5.5rem;
		align-items: end;
		gap: var(--space-3);
	}

	.value {
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
		line-height: 1;
		color: var(--color-text);
		white-space: nowrap;
	}

	.value.empty {
		color: var(--color-text-tertiary);
	}

	.unit {
		margin-left: 0.15em;
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
		letter-spacing: var(--tracking-normal);
		color: var(--color-text-tertiary);
	}

	/* The sparkline: a 2 px line over its box at any size, an 8 px end dot drawn as an HTML box. */
	.spark {
		position: relative;
		display: block;
		block-size: 2.25rem;
		color: var(--color-text-secondary);
	}

	.spark svg {
		display: block;
		inline-size: 100%;
		block-size: 100%;
		overflow: visible;
	}

	.spark polyline {
		fill: none;
		stroke: currentColor;
		stroke-width: 2px;
		stroke-linecap: round;
		stroke-linejoin: round;
		vector-effect: non-scaling-stroke;
	}

	.end {
		position: absolute;
		inline-size: 8px;
		block-size: 8px;
		border-radius: 50%;
		background: currentColor;
		box-shadow: 0 0 0 2px var(--color-surface-1);
		transform: translate(-50%, -50%);
	}

	/* As the charts: a hollow ring for an estimate, a square diamond for a measured value. */
	.end[data-shape='ring'] {
		background: var(--color-surface-1);
		border: 2px solid currentColor;
	}

	.end[data-shape='diamond'] {
		border-radius: 1px;
		transform: translate(-50%, -50%) rotate(45deg);
	}

	.line {
		font-size: var(--text-sm);
		line-height: var(--leading-snug);
		color: var(--color-text-secondary);
	}

	.quiet {
		color: var(--color-text-tertiary);
	}

	.delta {
		display: flex;
		align-items: flex-start;
		gap: var(--space-1-5);
	}

	.glyph {
		display: inline-flex;
		flex: none;
		height: 1.25em;
		align-items: center;
		color: var(--delta-color, var(--color-text-tertiary));
	}

	.delta strong {
		font-weight: var(--weight-semibold);
		color: var(--delta-color, var(--color-text));
	}

	.delta[data-tone='positive'] {
		--delta-color: light-dark(
			color-mix(in srgb, var(--color-positive) 82%, #000),
			var(--color-positive)
		);
	}

	.delta[data-tone='warning'] {
		--delta-color: light-dark(
			color-mix(in srgb, var(--color-warning) 82%, #000),
			var(--color-warning)
		);
	}

	.so-far {
		font-size: var(--text-xs);
	}

	/* A narrow tile (three to a row, or 320 px): the sparkline takes its own row under the value. */
	@container (width < 12rem) {
		.main {
			grid-template-columns: minmax(0, 1fr);
		}
	}
</style>
