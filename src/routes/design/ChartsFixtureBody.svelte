<!--
  @component
  /design's fixture chart body, its own chunk as a real body is: hard sets a week stacked by
  discipline over the target range, with the planned line and its markers. It uses the kit as a
  body under ui/charts/bodies/ will: scales and geometry in percent, marks sized by marks.css.
-->
<script lang="ts">
	import '#lib/ui/charts/marks.css';
	import { hitBands, linePath, areaPath, markers, stack } from '#lib/ui/charts/geometry.ts';
	import { SERIES_TOKEN, STACK_ORDER } from '#lib/ui/charts/palette.ts';
	import { formatTick, linearScale, timeTicks, weekBand } from '#lib/ui/charts/scale.ts';
	import type { ChartFixture } from './chart-fixture.ts';

	let { data }: { data: ChartFixture } = $props();

	const totals = $derived(
		data.weeks.map((week) => Object.values(week.sets).reduce((a, b) => a + (b ?? 0), 0))
	);
	const scale = $derived(
		linearScale([...totals, ...data.weeks.map((w) => w.planned), data.target[1]], 'bar')
	);
	const band = $derived(weekBand(data.weeks.map((week) => week.monday)));
	const centers = $derived(data.weeks.map((_, i) => band.center(i)));
	const planned = $derived(
		data.weeks.map((week, i) => ({ x: centers[i]!, y: scale.at(week.planned) }))
	);
	const target = $derived(
		[0, 100].map((x) => [
			{ x, y: scale.at(data.target[1]) },
			{ x, y: scale.at(data.target[0]) }
		])
	);
	const pct = (value: number) => `${value}%`;
</script>

<div class="pc-chart-body" aria-hidden="true" data-testid="chart-fixture-body">
	<div class="pc-area">
		{#each scale.ticks as tick (tick)}
			<div class="pc-gridline" style:--y={pct(scale.at(tick))} data-zero={tick === 0 || undefined}>
				<span class="pc-value-tick">{formatTick(tick, scale.step)}</span>
			</div>
		{/each}
		<svg class="pc-lines" viewBox="0 0 100 100" preserveAspectRatio="none">
			<path
				class="pc-fill"
				d={areaPath(
					target.map(([hi]) => hi!),
					target.map(([, lo]) => lo!)
				)}
				style:fill="var(--chart-band)"
			/>
		</svg>
		{#each data.weeks as week, i (week.monday)}
			{@const segments = stack(centers[i]!, week.sets, STACK_ORDER, scale)}
			{#each segments as segment (segment.key)}
				<span
					class="pc-seg"
					data-testid="chart-seg"
					data-first={segment.first || undefined}
					data-last={segment.last || undefined}
					data-so-far={week.inProgress || undefined}
					style:--x={pct(segment.left)}
					style:--b={pct(segment.bottom)}
					style:--h={pct(segment.height)}
					style:--band={pct(band.width)}
					style:--series={`var(${SERIES_TOKEN[segment.key]})`}
				></span>
			{/each}
			{#if week.inProgress}
				<span class="pc-so-far" style:--x={pct(centers[i]!)} style:--b={pct(scale.at(totals[i]!))}
					>so far</span
				>
			{/if}
		{/each}
		<svg class="pc-lines" viewBox="0 0 100 100" preserveAspectRatio="none">
			<path d={linePath(planned)} style:stroke="var(--chart-muted)" data-testid="chart-line" />
		</svg>
		{#each markers(planned) as marker (marker.index)}
			<span
				class="pc-marker"
				data-testid="chart-marker"
				style:--x={pct(marker.left)}
				style:--y={pct(marker.bottom)}
				style:--series="var(--chart-muted)"
			></span>
		{/each}
		{#each timeTicks(band.count) as i (i)}
			<span class="pc-time-tick" style:--x={pct(centers[i]!)}>{band.labels[i]}</span>
		{/each}
		{#each hitBands(centers) as hit, i (i)}
			<span class="pc-hit" style:--x={pct(hit.center)} style:--w={pct(hit.width)}></span>
		{/each}
	</div>
</div>
