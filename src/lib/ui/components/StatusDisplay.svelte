<!--
  @component
  Graphite 2004's Status Display: an inset backlit readout with a line on top, the big numeral (or
  a name), a dim line, an optional elapsed/total bar and an optional footer for the connection.
  Graphite's alone: StatusSlot.svelte loads the screen's display only on a page showing that design,
  so a device on the default design never fetches it.
  It carries no styles of its own: graphite.css draws it under the `status` hook. Every value
  arrives in words, composed by the screen from the data its own presentation shows.
-->
<script lang="ts" module>
	import type { IconName } from '../icons/icons';

	export interface StatusDisplayProps {
		/** The display's accessible name, e.g. 'Today’s session'. */
		label: string;
		/** The line on top: 'Week 1', 'Segment 2 of 5 · Tempo'. */
		line: string;
		/** The big readout: a numeral ('5:12'), or a name ('Full body') with `name`. */
		big: string;
		/** After the numeral, smaller: '/km'. */
		unit?: string;
		/** The readout is a name, set smaller than a numeral. */
		name?: boolean;
		/** The dim line under it. */
		dim?: string | null;
		/** Elapsed against total: words either side of the bar, and its fraction (0 to 1). */
		bar?: { label: string; start: string; end: string; progress: number } | null;
		/** The connection or the outbox, at the foot. */
		foot?: { icon: IconName; text: string } | null;
		'data-testid'?: string;
	}
</script>

<script lang="ts">
	import Icon from './Icon.svelte';

	let {
		label,
		line,
		big,
		unit,
		name = false,
		dim,
		bar,
		foot,
		...rest
	}: StatusDisplayProps = $props();

	const percent = $derived(bar ? Math.round(Math.min(1, Math.max(0, bar.progress)) * 100) : 0);
</script>

<section
	class="lcd"
	data-ui="status"
	data-kind={name ? 'name' : 'numeral'}
	aria-label={label}
	{...rest}
>
	<p class="line">{line}</p>
	<p class="big">
		{big}{#if unit}<span class="unit">&nbsp;{unit}</span>{/if}
	</p>
	{#if dim}<p class="line dim">{dim}</p>{/if}
	{#if bar}
		<div class="times">
			<span>{bar.start}</span>
			<span
				class="bar"
				role="progressbar"
				aria-label={bar.label}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={percent}
				aria-valuetext={bar.end}
			>
				<span class="fill" style:transform="scaleX({percent / 100})"></span>
			</span>
			<span>{bar.end}</span>
		</div>
	{/if}
	{#if foot}
		<p class="foot"><Icon name={foot.icon} size={14} strokeWidth={2} /><span>{foot.text}</span></p>
	{/if}
</section>
