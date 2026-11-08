<!--
  @component
  The range bars body (CHART_BODIES.range), drawn after hydration inside ChartFrame's plot box:
  muscle-group volume against its target range, a horizontal bar a group in one hue, largest
  first (bar-model.ts rangeModel). Behind each bar its range is a bracket, drawn open at the axis
  end when its high lies past it; a tick across the bar marks the plan. Each row's head names the
  group, its value and its status in words with an icon ('Below range', 'Within range', 'Above
  range'), so no status rests on colour. Rows, tooltips and keys are RowList's. Under forced
  colours the bars are CanvasText and the brackets outlined.
-->
<script lang="ts">
	import '../marks.css';
	import Icon from '../../components/Icon.svelte';
	import type { IconName } from '../../icons/icons';
	import {
		RANGE_STATUS,
		rangeModel,
		rangeReadout,
		type RangeBarsData,
		type RangeStatus
	} from '../bar-model.ts';
	import RowList from '../RowList.svelte';

	let { data }: { data: RangeBarsData } = $props();

	const model = $derived(rangeModel(data));
	const ICON: Record<RangeStatus, IconName> = {
		below: 'chevron-down',
		within: 'check',
		above: 'chevron-down'
	};
	const pct = (value: number) => `${value}%`;
</script>

<div class="pc-chart-body range" style:--series={`var(${data.token})`} data-testid="range-chart">
	<RowList
		title={data.title}
		count={model.marks.length}
		readout={(i) => rangeReadout(data, i)}
		ticks={model.ticks}
	>
		{#snippet legend()}
			<li class="pc-key" style:--key="var(--series)">Done</li>
			<li class="pc-key" data-key="range">Target range</li>
			{#if model.marks.some((m) => m.tick !== null)}<li class="pc-key" data-key="plan">
					Planned
				</li>{/if}
		{/snippet}
		{#snippet row(i)}
			{@const mark = model.marks[i]!}
			<span class="head">
				<span class="name">{mark.row.label}</span>
				<span class="value">
					{mark.row.value ? `${mark.row.value.text}${data.unit ? ` ${data.unit}` : ''}` : 'No data'}
				</span>
				{#if mark.status}
					<span class="status" data-status={mark.status} data-testid="range-status">
						<Icon name={ICON[mark.status]} size={14} strokeWidth={2.25} />{RANGE_STATUS[
							mark.status
						]}
					</span>
				{/if}
			</span>
			<span class="track">
				<span
					class="bracket"
					data-open={mark.bracket.open || undefined}
					data-testid="range-bracket"
					style:--l={pct(mark.bracket.left)}
					style:--w={pct(mark.bracket.width)}
				></span>
				{#if mark.width > 0}
					<span class="fill" data-testid="range-fill" style:--w={pct(mark.width)}></span>
				{/if}
				{#if mark.tick !== null}
					<span class="plan" data-testid="range-plan" style:--l={pct(mark.tick)}></span>
				{/if}
			</span>
		{/snippet}
	</RowList>
</div>

<style>
	.head {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
		min-inline-size: 0;
		white-space: nowrap;
	}

	.name {
		overflow: hidden;
		color: var(--color-text);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		text-overflow: ellipsis;
	}

	.value {
		color: var(--color-text-secondary);
	}

	.status {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		margin-inline-start: auto;
		color: var(--color-text-secondary);
	}

	.status[data-status='above'] :global(.icon) {
		rotate: 180deg;
	}

	/* The legend's keys: the bracket's band between its ends, the plan's tick. */
	[data-key='range']::before {
		border: 1px solid var(--chart-axis);
		border-block: 0;
		border-radius: 0;
		background: var(--chart-band);
	}

	[data-key='plan']::before {
		inline-size: 2px;
		block-size: 12px;
		border-radius: 1px;
		background: var(--color-text-secondary);
	}

	/* The track: the bracket behind, the bar from zero, the plan's tick across. */
	.track {
		position: relative;
		display: block;
		block-size: 10px;
	}

	.bracket {
		position: absolute;
		inset-block: -4px;
		left: var(--l);
		inline-size: var(--w);
		border: 1px solid var(--chart-axis);
		border-block: 0;
		background: var(--chart-band);
	}

	.bracket[data-open] {
		border-inline-end: 0;
	}

	/* One hue for every group, its data end rounded, square at zero. */
	.fill {
		position: absolute;
		inset-block: 0;
		left: 0;
		inline-size: var(--w);
		border-radius: 0 4px 4px 0;
		background: var(--series);
	}

	/* The plan: a 2 px tick with a surface ring, so it reads over the bar and off it. */
	.plan {
		position: absolute;
		inset-block: -5px;
		left: var(--l);
		inline-size: 2px;
		translate: -50% 0;
		border-radius: 1px;
		background: var(--color-text-secondary);
		box-shadow: 0 0 0 1px var(--chart-surface);
	}

	@media (forced-colors: active) {
		.fill,
		.plan {
			forced-color-adjust: none;
			background: CanvasText;
		}

		.plan {
			box-shadow: 0 0 0 1px Canvas;
		}

		.bracket {
			border-color: CanvasText;
		}
	}
</style>
