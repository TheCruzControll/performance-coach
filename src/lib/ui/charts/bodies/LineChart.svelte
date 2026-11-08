<!--
  @component
  The line chart body (CHART_BODIES.line), drawn after hydration inside ChartFrame's plot box. Up
  to four series in their given order: a legend names them from two, and direct labels at their
  ends, moved apart with leader lines when they collide. Under 18rem an end label is the series'
  number, which the legend repeats, so no line is told apart by colour alone. The SVG
  draws only the 2 px lines, the target band and the links to the week in progress; every mark
  with a pixel size is HTML (line-model.ts, marks.css): an 8 px end dot, hollow rings for
  estimates, square diamonds for measurements, and a dashed ring labelled 'so far'.

  Scrubbing: a pointer or a finger (touch-action pan-y, so a vertical swipe still scrolls) snaps an
  HTML crosshair to the nearest week, with one tooltip listing every series, kept inside the plot.
  The chart is one tab stop: ←, →, Home and End move the week and a polite live region reads it.
  Every value it shows is a cell of the table twin (lineTable).
-->
<script lang="ts">
	import '../marks.css';
	import { announce, lineModel, readout, type LineChartData } from '../line-model.ts';
	import { formatTick, nearestIndex } from '../scale.ts';

	let { data }: { data: LineChartData } = $props();

	const model = $derived(lineModel(data));
	const last = $derived(data.slots.length - 1);
	let root = $state<HTMLElement>();
	let area = $state<HTMLElement>();
	/** The week the crosshair is on; it stays put while the tooltip fades out. */
	let active = $state<number | null>(null);
	let shown = $state(false);
	let message = $state('');
	const current = $derived(readout(data, active ?? last));
	const pct = (value: number) => `${value}%`;
	const color = (series: number) => `var(${data.series[series]!.token})`;
	const kindWord = { estimated: 'Estimated', measured: 'Measured' } as const;

	function scrub(event: PointerEvent | MouseEvent) {
		if (!area || last < 0) return;
		const box = area.getBoundingClientRect();
		active = nearestIndex(model.xs, ((event.clientX - box.left) / box.width) * 100);
		shown = true;
	}

	function move(event: KeyboardEvent) {
		if (last < 0) return;
		const from = active ?? last;
		const keys: Partial<Record<string, number>> = {
			ArrowLeft: Math.max(0, from - 1),
			ArrowRight: Math.min(last, from + 1),
			Home: 0,
			End: last
		};
		const to = keys[event.key];
		if (event.key === 'Escape') shown = false;
		if (to === undefined) return;
		event.preventDefault();
		active = to;
		shown = true;
		message = announce(data, to);
	}

	function focus() {
		if (last < 0) return;
		active ??= last;
		shown = true;
		if (root?.matches(':focus-visible')) message = announce(data, active);
	}

	function leave(event: PointerEvent) {
		if (event.pointerType === 'mouse' && document.activeElement !== root) shown = false;
	}
</script>

<!-- One tab stop for the whole chart: the arrow keys move between weeks inside it. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div
	bind:this={root}
	class="pc-chart-body line"
	role="group"
	aria-label={`${data.title}: use the arrow keys to read each week`}
	tabindex="0"
	onkeydown={move}
	onfocus={focus}
	onblur={() => (shown = false)}
	data-testid="line-chart"
>
	{#if model.legend || model.shapes.estimated || model.shapes.measured || model.shapes.soFar}
		<ul class="legend" aria-hidden="true" data-testid="line-legend">
			{#if model.legend}
				{#each data.series as s, i (s.key)}
					<li>
						<span class="swatch" style:--series={color(i)}></span><span class="ordinal"
							>{i + 1}</span
						>{s.label}
					</li>
				{/each}
			{/if}
			{#if model.shapes.estimated}
				<li><span class="key" data-kind="estimated"></span>Estimated</li>
			{/if}
			{#if model.shapes.measured}
				<li><span class="key" data-kind="measured"></span>Measured</li>
			{/if}
			{#if model.shapes.soFar}
				<li><span class="key" data-kind="so-far"></span>So far</li>
			{/if}
		</ul>
	{/if}
	<div class="plot" aria-hidden="true">
		<div
			bind:this={area}
			class="pc-area"
			class:labelled={model.endLabels.length > 0}
			onpointerdown={scrub}
			onpointermove={scrub}
			onpointerleave={leave}
			onclick={scrub}
			role="presentation"
		>
			{#each model.scale.ticks as tick (tick)}
				<div class="pc-gridline" style:--y={pct(model.scale.at(tick))}>
					<span class="pc-value-tick">{formatTick(tick, model.scale.step)}</span>
				</div>
			{/each}
			{#if model.baseline !== null}
				<div class="pc-gridline" data-zero style:--y={pct(model.baseline)}></div>
			{/if}
			{#each model.hits as hit, i (i)}
				<span class="pc-hit" style:--x={pct(hit.center)} style:--w={pct(hit.width)}></span>
			{/each}
			<svg class="pc-lines" viewBox="0 0 100 100" preserveAspectRatio="none">
				{#if model.band}
					<path class="pc-fill" d={model.band} style:fill="var(--chart-band)" />
				{/if}
				{#each model.endLabels as label (label.series)}
					{#if label.leader}<path class="leader" d={label.leader} />{/if}
				{/each}
				{#each model.paths as path, i (data.series[i]!.key)}
					<path d={path.line} style:stroke={color(i)} data-testid="line-path" />
					{#if path.link}<path class="link" d={path.link} style:stroke={color(i)} />{/if}
				{/each}
			</svg>
			<span
				class="crosshair"
				data-shown={shown ? '' : undefined}
				style:--x={pct(model.xs[active ?? last] ?? 0)}
			></span>
			{#each model.marks as mark (`${mark.series}:${mark.index}`)}
				<span
					class="pc-marker"
					data-testid="line-mark"
					data-kind={mark.kind}
					data-so-far={mark.kind === 'so-far' || undefined}
					style:--x={pct(mark.left)}
					style:--y={pct(mark.bottom)}
					style:--series={color(mark.series)}
				></span>
			{/each}
			{#if model.soFar}
				<span
					class="so-far"
					data-below={model.soFar.below || undefined}
					style:--x={pct(model.soFar.x)}
					style:--y={pct(model.soFar.y)}>so far</span
				>
			{/if}
			{#each model.endLabels as label (label.series)}
				<span class="end-label" style:--y={pct(label.labelY)} data-testid="line-end-label">
					<span class="swatch" style:--series={color(label.series)}></span><span class="ordinal"
						>{label.series + 1}</span
					><span class="name">{data.series[label.series]!.label}</span>
				</span>
			{/each}
			{#each model.ticks as tick (tick.index)}
				<span
					class="pc-time-tick"
					data-minor={tick.minor || undefined}
					style:--x={pct(model.xs[tick.index]!)}>{data.slots[tick.index]!.tick}</span
				>
			{/each}
			{#if last >= 0}
				<div
					class="tip"
					data-shown={shown ? '' : undefined}
					style:--x={pct(model.xs[active ?? last]!)}
					data-testid="line-tooltip"
				>
					<p class="tip-heading">{current.heading}</p>
					{#each current.rows as row (row.series)}
						<p class="tip-row">
							<span class="swatch" style:--series={color(row.series)}></span>
							<span class="tip-label">{row.label}</span>
							<span class="tip-value">{row.value ?? 'No data'}</span>
							{#if row.kind}
								<span class="tip-kind"
									><span class="key" data-kind={row.kind}></span>{kindWord[row.kind]}</span
								>
							{/if}
						</p>
					{/each}
				</div>
			{/if}
		</div>
	</div>
	<p class="visually-hidden" role="status" data-testid="line-live">{message}</p>
</div>

<style>
	.line {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		container-type: inline-size;
		border-radius: var(--radius-xs);
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

	.legend li,
	.tip-kind {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1-5);
	}

	.swatch {
		flex: none;
		inline-size: 12px;
		block-size: 2px;
		border-radius: 1px;
		background: var(--series);
	}

	/* The marker shapes, as keys: muted, the same sizes as the marks they name. */
	.key {
		flex: none;
		inline-size: 8px;
		block-size: 8px;
		border-radius: 50%;
		box-shadow: inset 0 0 0 2px var(--chart-muted);
	}

	.key[data-kind='measured'] {
		inline-size: 7px;
		block-size: 7px;
		margin-inline: 0.5px;
		border-radius: 1px;
		rotate: 45deg;
		background: var(--chart-muted);
	}

	.key[data-kind='so-far'] {
		box-shadow: none;
		outline: 2px dashed var(--chart-muted);
		outline-offset: -2px;
	}

	.plot {
		position: relative;
		flex: 1;
		min-block-size: 0;
	}

	.pc-area {
		touch-action: pan-y;
	}

	.leader {
		stroke: var(--chart-axis);
		stroke-width: 1px;
	}

	.link {
		opacity: 0.5;
	}

	/* Direct labels in a column right of the plot: the series' number under 18rem (the legend
	   repeats it, and every other week's tick steps aside), its name from 18rem. */
	.pc-area.labelled {
		right: 2rem;
	}

	.end-label {
		position: absolute;
		left: calc(100% + var(--space-2));
		bottom: var(--y);
		display: flex;
		align-items: center;
		gap: var(--space-1);
		translate: 0 50%;
		color: var(--color-text-secondary);
		white-space: nowrap;
	}

	.ordinal {
		font-weight: var(--weight-semibold);
	}

	.end-label .name {
		display: none;
	}

	@container (width >= 18rem) {
		.pc-area.labelled {
			right: 4.5rem;
		}

		.end-label {
			max-inline-size: calc(4.5rem - var(--space-2));
		}

		.end-label .name {
			display: inline;
		}

		.ordinal {
			display: none;
		}
	}

	@container (width < 18rem) {
		.pc-time-tick[data-minor] {
			display: none;
		}
	}

	.end-label .swatch {
		inline-size: 8px;
	}

	.so-far {
		position: absolute;
		left: var(--x);
		bottom: calc(var(--y) + var(--space-2));
		translate: -50% 0;
		color: var(--color-text-secondary);
		white-space: nowrap;
	}

	.so-far[data-below] {
		bottom: calc(var(--y) - var(--space-2));
		translate: -50% 100%;
	}

	.crosshair,
	.tip {
		opacity: 0;
		visibility: hidden;
		transition:
			opacity var(--duration-base) var(--ease-standard),
			visibility 0s linear var(--duration-base);
		pointer-events: none;
	}

	.crosshair[data-shown],
	.tip[data-shown] {
		opacity: 1;
		visibility: visible;
		transition: opacity var(--duration-base) var(--ease-standard);
	}

	.crosshair {
		position: absolute;
		inset-block: 0;
		left: var(--x);
		border-inline-start: 1px solid var(--chart-baseline);
	}

	/* Kept inside the plot: its own width slides by the crosshair's share of the plot's. */
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
	}

	.tip-heading {
		color: var(--color-text-secondary);
		font-weight: var(--weight-semibold);
	}

	.tip-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0 var(--space-1-5);
	}

	.tip-label {
		color: var(--color-text-secondary);
	}

	.tip-value {
		font-weight: var(--weight-semibold);
	}

	.tip-kind {
		color: var(--color-text-secondary);
	}

	@media (hover: hover) and (pointer: fine) {
		.pc-area {
			cursor: crosshair;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.crosshair,
		.tip,
		.crosshair[data-shown],
		.tip[data-shown] {
			transition: none;
		}
	}
</style>
