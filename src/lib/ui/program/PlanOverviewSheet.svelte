<!--
  @component
  Train's plan overview: the BottomSheet with the BlockTimeline it holds, both code-split out of
  Train's initial JavaScript (Train imports this on first intent). A tap on a planned week closes
  the sheet and hands the week's number to `onweek`, which opens it on Train; a tap that opens a
  new tab or window (a modifier key, a middle click) stays the browser's.
-->
<script lang="ts">
	import BottomSheet from '../components/BottomSheet.svelte';
	import BlockTimeline from './BlockTimeline.svelte';
	import type { TimelineBlock } from './timeline.ts';

	interface Props {
		open: boolean;
		/** The program's title. */
		title: string;
		blocks: readonly TimelineBlock[];
		weekHref: (week: number) => string;
		onweek: (week: number) => void;
		onclose: () => void;
	}

	let { open = $bindable(), title, blocks, weekHref, onweek, onclose }: Props = $props();

	function go(event: MouseEvent, week: number) {
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
			return;
		event.preventDefault();
		open = false;
		onweek(week);
	}
</script>

<BottomSheet bind:open title="Your plan" description={title} {onclose} data-testid="plan-sheet">
	<BlockTimeline {blocks} {weekHref} onweek={go} data-testid="block-timeline" />
</BottomSheet>
