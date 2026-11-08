<!--
  @component
  The bar chart body (CHART_BODIES.bar), drawn after hydration inside ChartFrame's plot box. One
  series is a column a week; two or more are stacked by discipline in STACK_ORDER, a 2 px surface
  gap between parts, a rect-key legend naming them and each complete stack's total on its cap
  where it fits (a cap hides when its week's band is too narrow for it). Columns are HTML boxes
  (bar-model.ts, marks.css): at most 24 px wide, a 4 px rounded data end, square at the baseline.
  The SVG draws only the optional target band. A planned outline, dashed, stands around each
  column; the week in progress is outlined, not filled, and labelled 'so far'.

  Every mark is a button (a hit area of at least 24 × 24 px) whose name says its week, part, total
  and plan; hover, a tap or focus shows the same words in a tooltip. One mark holds the tab stop
  (roving): ← and → move between weeks, ↑ and ↓ along a stack, Home and End to the ends, Escape
  hides the tooltip. Under forced colours the parts are CanvasText outlines with alternating
  45° and 135° hatches, which the legend repeats.
-->
<script lang="ts">
	import '../marks.css';
	import {
		barModel,
		barReadout,
		formatTotal,
		markName,
		stepMark,
		type BarChartData
	} from '../bar-model.ts';
	import { formatTick } from '../scale.ts';

	let { data }: { data: BarChartData } = $props();

	const model = $derived(barModel(data));
	let root = $state<HTMLElement>();
	let buttons = $state<HTMLButtonElement[]>([]);
	/** The mark holding the tab stop and the tooltip: the newest until another is chosen. */
	let active = $state<number | null>(null);
	let focused: number | null = null;
	let shown = $state(false);
	const stop = $derived(Math.min(active ?? Infinity, model.marks.length - 1));
	const current = $derived(barReadout(data, model, stop));
	const pct = (value: number) => `${value}%`;
	const color = (series: number) =>
		series < 0 ? 'transparent' : `var(${model.series[series]!.token})`;
	const targetText = $derived.by(() => {
		if (!data.target) return null;
		const [low, high] = data.target;
		const range =
			high === null ? `${formatTotal(low)}+` : `${formatTotal(low)}–${formatTotal(high)}`;
		return `Target ${range}${data.unit ? ` ${data.unit}` : ''}`;
	});
	const legend = $derived(
		model.stacked || model.plans.length > 0 || model.soFar !== null || targetText !== null
	);

	function show(index: number) {
		active = index;
		shown = true;
	}

	function key(event: KeyboardEvent) {
		if (event.key === 'Escape') shown = false;
		const to = stepMark(model, stop, event.key);
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

<!-- The marks are the controls; the group only routes their arrow keys. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
	bind:this={root}
	class="pc-chart-body bar"
	role="group"
	aria-label={`${data.title}: use the arrow keys to move between columns`}
	onkeydown={key}
	onfocusout={out}
	data-testid="bar-chart"
>
	{#if legend}
		<ul class="legend" aria-hidden="true" data-testid="bar-legend">
			{#if model.stacked}
				{#each model.series as s, i (s.key)}
					<li>
						<span class="key" data-hatch={model.hatches[i]} style:--series={color(i)}
						></span>{s.label}
					</li>
				{/each}
			{/if}
			{#if model.plans.length}<li><span class="key" data-key="planned"></span>Planned</li>{/if}
			{#if model.soFar}<li><span class="key" data-key="so-far"></span>So far</li>{/if}
			{#if targetText}<li><span class="key" data-key="target"></span>{targetText}</li>{/if}
		</ul>
	{/if}
	<div class="plot">
		<div class="pc-area" style:--band={pct(model.band)}>
			<div class="decor" aria-hidden="true">
				{#each model.scale.ticks as tick (tick)}
					<div
						class="pc-gridline"
						style:--y={pct(model.scale.at(tick))}
						data-zero={tick === 0 || undefined}
					>
						<span class="pc-value-tick">{formatTick(tick, model.scale.step)}</span>
					</div>
				{/each}
				{#if model.targetPath}
					<svg class="pc-lines" viewBox="0 0 100 100" preserveAspectRatio="none">
						<path class="pc-fill" d={model.targetPath} style:fill="var(--chart-band)" />
					</svg>
				{/if}
				{#each model.plans as plan (plan.slot)}
					<span
						class="plan"
						data-testid="bar-plan"
						style:--x={pct(plan.left)}
						style:--b={pct(plan.bottom)}
						style:--h={pct(plan.height)}
					></span>
				{/each}
				{#each model.caps as cap (cap.slot)}
					<span
						class="cap"
						data-before-so-far={cap.beforeSoFar || undefined}
						style:--x={pct(cap.left)}
						style:--b={pct(cap.bottom)}
						><span class="cap-text" data-wide={cap.text.length > 3 || undefined}>{cap.text}</span
						></span
					>
				{/each}
				{#if model.soFar}
					<span
						class="pc-so-far"
						data-testid="bar-so-far"
						style:--x={pct(model.soFar.left)}
						style:--b={pct(model.soFar.bottom)}>so far</span
					>
				{/if}
				{#each model.ticks as tick (tick.index)}
					<span
						class="pc-time-tick"
						data-minor={tick.minor || undefined}
						style:--x={pct(model.xs[tick.index]!)}>{data.slots[tick.index]!.tick}</span
					>
				{/each}
			</div>
			{#each model.marks as mark, i (`${mark.slot}:${mark.series}`)}
				<button
					bind:this={buttons[i]}
					type="button"
					class={['pc-bar', model.stacked && mark.series >= 0 ? 'pc-seg' : 'pc-col']}
					tabindex={i === stop ? 0 : -1}
					aria-label={markName(data, model, i)}
					data-testid="bar-mark"
					data-slot={mark.slot}
					data-series={mark.series < 0 ? 'planned' : model.series[mark.series]!.key}
					data-plan={mark.series < 0 || undefined}
					data-hatch={mark.series < 0 ? undefined : model.hatches[mark.series]}
					data-first={mark.first || undefined}
					data-last={mark.last || undefined}
					data-negative={mark.negative || undefined}
					data-so-far={mark.soFar || undefined}
					style:--x={pct(mark.left)}
					style:--b={pct(mark.bottom)}
					style:--h={pct(mark.height)}
					style:--series={color(mark.series)}
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
				></button>
			{/each}
			{#if model.marks.length}
				<div
					class="tip"
					aria-hidden="true"
					data-shown={shown ? '' : undefined}
					style:--x={pct(model.marks[stop]!.left)}
					data-testid="bar-tooltip"
				>
					<p class="tip-heading">{current.heading}</p>
					{#each current.rows as row, r (r)}
						<p class="tip-row">
							{#if row.series !== undefined}
								<span
									class="key"
									data-hatch={model.hatches[row.series]}
									style:--series={color(row.series)}
								></span>
							{/if}
							<span class="tip-label">{row.label}</span>
							<span class="tip-value">{row.value}</span>
						</p>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</div>

<style>
	.bar {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		container-type: inline-size;
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

	.legend li {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1-5);
	}

	/* Rect keys: a part's colour, the planned dash, the so-far outline, the target's band. */
	.key {
		flex: none;
		inline-size: 10px;
		block-size: 10px;
		border-radius: 2px;
		background: var(--series);
	}

	.key[data-key='planned'] {
		background: none;
		border: 1px dashed var(--chart-muted);
	}

	.key[data-key='so-far'] {
		background: none;
		box-shadow: inset 0 0 0 2px var(--chart-muted);
	}

	.key[data-key='target'] {
		background: var(--chart-band);
		box-shadow: inset 0 0 0 1px var(--chart-axis);
	}

	.plot {
		position: relative;
		flex: 1;
		min-block-size: 0;
	}

	@container (width < 18rem) {
		.pc-time-tick[data-minor] {
			display: none;
		}
	}

	/* The plan stands 3 px proud of its column each side, so it shows even under a taller one. */
	.plan {
		position: absolute;
		left: var(--x);
		bottom: var(--b);
		block-size: var(--h);
		inline-size: calc(min(24px, calc(var(--band) * 0.6)) + 6px);
		translate: -50% 0;
		border: 1px dashed var(--chart-muted);
		border-block-end: 0;
		border-radius: 5px 5px 0 0;
	}

	/* A total sits on its cap in a box its week's width, and hides when it would not fit there. */
	.cap {
		position: absolute;
		left: var(--x);
		bottom: calc(var(--b) + var(--space-1));
		inline-size: var(--band);
		translate: -50% 0;
		container-type: inline-size;
		color: var(--color-text-secondary);
		text-align: center;
	}

	.cap-text {
		display: block;
		white-space: nowrap;
	}

	@container (width < 1.5rem) {
		.cap-text {
			display: none;
		}
	}

	@container (width < 2.25rem) {
		.cap-text[data-wide] {
			display: none;
		}
	}

	/* 'so far' spills into the week before when the weeks are narrow: that cap steps aside. */
	@container (width < 2.75rem) {
		.cap[data-before-so-far] .cap-text {
			display: none;
		}
	}

	.pc-bar {
		margin: 0;
		padding: 0;
		border: 0;
		color: inherit;
		font: inherit;
		appearance: none;
		-webkit-tap-highlight-color: transparent;
	}

	.pc-seg:not([data-last]) {
		border-radius: 0;
	}

	/*
	 * The hit areas lie under every painted mark, so a short part keeps its own taps and hover
	 * however a neighbour's area spreads over it: the area is its own stacking context, the
	 * drawing ignores the pointer, and a mark is centred by a margin, as a translate would make
	 * it a stacking context of its own and lift its hit area with it.
	 */
	.bar .pc-area {
		isolation: isolate;
	}

	.decor {
		pointer-events: none;
	}

	.bar .pc-bar {
		translate: none;
		margin-inline-start: calc(min(24px, calc(var(--band) * 0.6)) / -2);
	}

	/* The hit area: at least 24 × 24 px, centred on the mark however thin it is. */
	.pc-bar::after {
		content: '';
		position: absolute;
		z-index: -1;
		left: 50%;
		top: 50%;
		inline-size: max(100%, 24px);
		block-size: max(100%, 24px);
		translate: -50% -50%;
	}

	@media (hover: hover) and (pointer: fine) {
		.pc-bar:hover {
			outline: 1px solid var(--color-text-secondary);
			outline-offset: 1px;
		}
	}

	.pc-bar:focus-visible {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	.tip {
		position: absolute;
		top: 0;
		left: var(--x);
		translate: calc(var(--x) * -1) 0;
		display: grid;
		gap: var(--space-1);
		min-inline-size: 9rem;
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

	.tip[data-shown] {
		opacity: 1;
		visibility: visible;
		transition: opacity var(--duration-base) var(--ease-standard);
	}

	.tip-heading,
	.tip-label {
		color: var(--color-text-secondary);
	}

	.tip-heading {
		font-weight: var(--weight-semibold);
	}

	.tip-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0 var(--space-1-5);
	}

	.tip-value {
		font-weight: var(--weight-semibold);
	}

	@media (prefers-reduced-motion: reduce) {
		.tip,
		.tip[data-shown] {
			transition: none;
		}
	}

	/* Forced colours drop the hues: CanvasText outlines and hatches tell the parts apart. */
	@media (forced-colors: active) {
		.pc-bar:not([data-plan]),
		.key[data-hatch] {
			forced-color-adjust: none;
			border: 1px solid CanvasText;
			background: repeating-linear-gradient(var(--hatch), CanvasText 0 1px, Canvas 1px 5px);
		}

		[data-hatch='a'] {
			--hatch: 45deg;
		}

		[data-hatch='b'] {
			--hatch: 135deg;
		}

		.pc-bar[data-so-far]:not([data-plan]) {
			border: 2px dashed CanvasText;
			background: repeating-linear-gradient(var(--hatch), CanvasText 0 1px, Canvas 1px 5px);
			box-shadow: none;
		}
	}
</style>
