<!--
  @component
  The diverging bars body (CHART_BODIES.diverging), drawn after hydration inside ChartFrame's plot
  box: actual minus target RPE a row an exercise, as given, a horizontal bar from zero in the
  middle (bar-model.ts divergingModel). Easier than planned runs left in --chart-diverge-cool,
  harder runs right in --chart-diverge-warm, and within ±0.5 of target is the hueless
  --chart-diverge-mid (a 2 px stub at exactly zero). Each row's head says the signed value and
  its side in words ('Easier', 'On target', 'Harder'), so no side rests on colour. Rows, tooltips
  and keys are RowList's. Under forced colours the bars are CanvasText, their sides in words.
-->
<script lang="ts">
	import '../marks.css';
	import {
		DIVERGE_WORDS,
		divergingModel,
		divergingReadout,
		ON_TARGET_RPE,
		type DivergeTone,
		type DivergingBarsData
	} from '../bar-model.ts';
	import { DIVERGING } from '../palette.ts';
	import RowList from '../RowList.svelte';

	let { data }: { data: DivergingBarsData } = $props();

	const model = $derived(divergingModel(data));
	const tone = (t: DivergeTone) => `var(${DIVERGING[t]})`;
	const pct = (value: number) => `${value}%`;
	const TONES: DivergeTone[] = ['below', 'zero', 'above'];
</script>

<div class="pc-chart-body diverging" data-testid="diverging-chart">
	<RowList
		title={data.title}
		count={model.marks.length}
		readout={(i) => divergingReadout(data, i)}
		ticks={model.ticks}
	>
		{#snippet legend()}
			{#each TONES as t (t)}
				<li class="pc-key" style:--key={tone(t)}>
					{DIVERGE_WORDS[t]}{t === 'zero' ? ` ±${ON_TARGET_RPE}` : ''}
				</li>
			{/each}
		{/snippet}
		{#snippet row(i)}
			{@const mark = model.marks[i]!}
			<span class="head">
				<span class="name">{mark.row.label}</span>
				{#if mark.tone && mark.text}
					<span class="value" data-testid="diverging-value">{mark.text}</span>
					<span class="side" data-testid="diverging-side">{DIVERGE_WORDS[mark.tone]}</span>
				{:else}
					<span class="side">No data</span>
				{/if}
			</span>
			<span class="track">
				{#if mark.tone}
					<span
						class="fill"
						data-tone={mark.tone}
						data-side={mark.diff! < 0 ? 'left' : mark.diff! > 0 ? 'right' : 'flat'}
						data-testid="diverging-fill"
						style:--l={pct(mark.left)}
						style:--w={pct(mark.width)}
						style:--tone={tone(mark.tone)}
					></span>
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
		margin-inline-start: auto;
		color: var(--color-text);
		font-weight: var(--weight-semibold);
	}

	.side {
		color: var(--color-text-secondary);
	}

	.value + .side {
		min-inline-size: 4.5em;
	}

	.side:only-child,
	.name + .side {
		margin-inline-start: auto;
	}

	.track {
		position: relative;
		display: block;
		block-size: 10px;
	}

	/* From zero to the difference; the data end, away from zero, is the rounded one. */
	.fill {
		position: absolute;
		inset-block: 0;
		left: var(--l);
		inline-size: max(2px, var(--w));
		background: var(--tone);
	}

	.fill[data-side='right'] {
		border-radius: 0 4px 4px 0;
	}

	.fill[data-side='left'] {
		border-radius: 4px 0 0 4px;
	}

	/* A difference of exactly zero is a 2 px stub centred on zero. */
	.fill[data-side='flat'] {
		translate: -50% 0;
		border-radius: 1px;
	}

	@media (forced-colors: active) {
		.fill {
			forced-color-adjust: none;
			background: CanvasText;
		}
	}
</style>
