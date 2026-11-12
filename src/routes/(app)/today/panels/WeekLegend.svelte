<!--
  @component
  The week strip's legend (Graphite 2004 only, through StatusSlot.svelte): a key per discipline the
  strip's dots show and the skipped ring (week-legend.ts), in rows of three; nothing for a week
  with no sessions. Hidden from assistive tech, as
  the strip's dots are: each day's name says its sessions in words. It carries no styles of its
  own: graphite.css draws it under the `week-legend` hook.
-->
<script lang="ts">
	import type { StripDayView } from '#lib/ui/program/words.ts';
	import { weekLegend } from './week-legend';

	let { days }: { days: readonly Pick<StripDayView, 'dots'>[] } = $props();
	const keys = $derived(weekLegend(days));
</script>

<ul data-ui="week-legend" aria-hidden="true" data-testid="week-legend">
	{#each keys as key (key.label)}
		<li>
			<span
				class="key"
				class:ring={key.tone === null}
				style:--tone={key.tone ? `var(--color-${key.tone})` : undefined}
			></span>{key.label}
		</li>
	{/each}
</ul>
