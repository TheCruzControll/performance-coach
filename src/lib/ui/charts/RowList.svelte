<!--
  @component
  The rows a horizontal bar body draws (bodies/RangeBars.svelte, bodies/DivergingBars.svelte),
  loaded only with them: a legend in words, then one row a group or exercise, each a button at least 44 px tall whose name
  says every value and status in words, over vertical gridlines and a value axis under the rows.
  The body draws each row's head and track through `row`. Hover, a tap or focus shows the row's
  words in a tooltip, beside the row and inside the plot. One row holds the tab stop (roving): the
  arrow keys move up and down, Home and End to the ends, Escape hides the tooltip.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { rowName, stepRow, type RowReadout, type RowTick } from './bar-model.ts';

	interface Props {
		/** Names the keyboard group: the frame's title. */
		title: string;
		count: number;
		readout: (index: number) => RowReadout;
		ticks: readonly RowTick[];
		/** The keys over the rows: what each mark means, in words. */
		legend: Snippet;
		row: Snippet<[number]>;
	}

	let { title, count, readout, ticks, legend, row }: Props = $props();

	let root = $state<HTMLElement>();
	let buttons = $state<HTMLButtonElement[]>([]);
	/** The row holding the tab stop and the tooltip: the first until another is chosen. */
	let active = $state(0);
	let focused: number | null = null;
	let shown = $state(false);
	const stop = $derived(Math.min(active, count - 1));
	const current = $derived(readout(stop));
	const pct = (value: number) => `${value}%`;

	function show(index: number) {
		active = index;
		shown = true;
	}

	function key(event: KeyboardEvent) {
		if (event.key === 'Escape') shown = false;
		const to = stepRow(count, stop, event.key);
		if (to === null) return;
		event.preventDefault();
		buttons[to]?.focus();
		show(to);
	}

	function leave(event: PointerEvent) {
		if (event.pointerType !== 'mouse') return;
		if (focused === null) shown = false;
		else active = focused;
	}

	function out(event: FocusEvent) {
		if (root?.contains(event.relatedTarget as Node | null)) return;
		focused = null;
		shown = false;
	}
</script>

<!-- The rows are the controls; the group only routes their arrow keys. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
	bind:this={root}
	class="list"
	role="group"
	aria-label={`${title}: use the arrow keys to move between rows`}
	onkeydown={key}
	onfocusout={out}
>
	<ul class="legend" aria-hidden="true" data-testid="row-legend">{@render legend()}</ul>
	<div class="area">
		<div class="decor" aria-hidden="true">
			{#each ticks as tick (tick.at)}
				<span class="grid" data-zero={tick.zero || undefined} style:--x={pct(tick.at)}>
					<span class="tick">{tick.text}</span>
				</span>
			{/each}
		</div>
		<div class="rows" style:--rows={count}>
			{#each { length: count }, i (i)}
				<button
					bind:this={buttons[i]}
					type="button"
					class="row"
					tabindex={i === stop ? 0 : -1}
					aria-label={rowName(readout(i))}
					data-testid="row-mark"
					onfocus={() => {
						focused = i;
						show(i);
					}}
					onclick={() => {
						buttons[i]?.focus();
						show(i);
					}}
					onpointerenter={(event) => event.pointerType === 'mouse' && show(i)}
					onpointerleave={leave}
				>
					{@render row(i)}
				</button>
			{/each}
		</div>
		{#if count}
			<!-- Under the row in the top half, over it in the bottom half: always inside the plot. -->
			<div
				class="tip"
				aria-hidden="true"
				data-shown={shown || undefined}
				data-above={stop >= count / 2 || undefined}
				style:--i={stop}
				style:--rows={count}
				data-testid="row-tooltip"
			>
				<p class="tip-heading">{current.heading}</p>
				{#each current.rows as line (line.label)}
					<p class="tip-row">
						<span class="tip-label">{line.label}</span>
						<span class="tip-value">{line.value}</span>
					</p>
				{/each}
			</div>
		{/if}
	</div>
</div>

<style>
	.list {
		position: absolute;
		inset: 0;
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
	}

	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-3);
		margin: 0;
		padding: 0;
		list-style: none;
		color: var(--color-text-secondary);
	}

	/* The rows and their axis: what the tooltip's place is reckoned in. */
	.area {
		position: relative;
		flex: 1;
		min-block-size: 0;
	}

	/* The gridlines run behind the rows; their labels sit in the axis band below. */
	.decor {
		position: absolute;
		inset: 0 0 var(--chart-axis-band);
		pointer-events: none;
	}

	.grid {
		position: absolute;
		inset-block: 0;
		left: var(--x);
		border-inline-start: 1px solid var(--chart-grid);
	}

	.grid[data-zero] {
		border-inline-start-color: var(--chart-baseline);
	}

	.tick {
		position: absolute;
		top: calc(100% + var(--space-2));
		translate: -50% 0;
		white-space: nowrap;
	}

	/* The first and last labels keep inside the plot. */
	.grid:first-child .tick {
		translate: 0 0;
	}

	.grid:last-child .tick {
		translate: -100% 0;
	}

	.rows {
		position: absolute;
		inset: 0 0 var(--chart-axis-band);
		display: grid;
		grid-template-rows: repeat(var(--rows), 1fr);
	}

	.row {
		display: grid;
		align-content: center;
		gap: var(--space-1-5);
		min-block-size: 44px;
		margin: 0;
		padding: 0;
		border: 0;
		border-radius: var(--radius-xs);
		background: none;
		color: inherit;
		font: inherit;
		text-align: start;
		appearance: none;
		-webkit-tap-highlight-color: transparent;
		transition: background-color var(--duration-fast) var(--ease-standard);
	}

	@media (hover: hover) and (pointer: fine) {
		.row:hover {
			background: color-mix(in srgb, var(--color-text) 6%, transparent);
		}
	}

	.row:focus-visible {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	.tip {
		position: absolute;
		top: calc((var(--i) + 1) * (100% - var(--chart-axis-band)) / var(--rows));
		left: 0;
		z-index: 1;
		display: grid;
		grid-template-columns: repeat(2, auto);
		gap: var(--space-1) var(--space-3);
		min-inline-size: 10rem;
		max-inline-size: 100%;
		padding: var(--space-2) var(--space-3);
		border: 1px solid var(--color-border-strong);
		border-radius: var(--radius-sm);
		background: var(--color-surface-2);
		box-shadow: var(--elevation-2);
		color: var(--color-text);
		line-height: var(--leading-normal);
		opacity: 0;
		visibility: hidden;
		transition:
			opacity var(--duration-base) var(--ease-standard),
			visibility 0s linear var(--duration-base);
		pointer-events: none;
	}

	.tip[data-above] {
		top: auto;
		bottom: calc(
			var(--chart-axis-band) + (var(--rows) - var(--i)) * (100% - var(--chart-axis-band)) /
				var(--rows)
		);
	}

	.tip[data-shown] {
		opacity: 1;
		visibility: visible;
		transition: opacity var(--duration-base) var(--ease-standard);
	}

	.tip-heading,
	.tip-label {
		color: var(--color-text-secondary);
	}

	/* Two pairs a line under the heading, so the tooltip stays short beside a 48 px row. */
	.tip-heading {
		grid-column: 1 / -1;
		font-weight: var(--weight-semibold);
	}

	.tip-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0 var(--space-1-5);
	}

	.tip-value {
		font-weight: var(--weight-semibold);
	}

	@media (prefers-reduced-motion: reduce) {
		.row,
		.tip,
		.tip[data-shown] {
			transition: none;
		}
	}
</style>
