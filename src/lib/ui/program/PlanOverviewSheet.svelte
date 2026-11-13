<!--
  @component
  Train's plan overview: the BottomSheet with the BlockTimeline it holds, both code-split out of
  Train's initial JavaScript (Train imports this on first intent). A tap on a planned week closes
  the sheet and hands the week's number to `onweek`, which opens it on Train; a tap that opens a
  new tab or window (a modifier key, a middle click) stays the browser's.

  The timeline is the season's region, 'Your season' (m7/39: `road`, streamed with Train's data):
  M3's timeline, aria-busy with a polite 'Loading your season' and the room of `openGoals` lanes
  held, until the season arrives; a road that answers null or fails leaves M3's timeline exactly
  (no season passed: no track, lanes or counted rows), with no error shown.
-->
<script lang="ts">
	import BottomSheet from '../components/BottomSheet.svelte';
	import BlockTimeline from './BlockTimeline.svelte';
	import type { SeasonView } from './season.ts';
	import type { TimelineBlock } from './timeline.ts';

	interface Props {
		open: boolean;
		/** The program's title. */
		title: string;
		blocks: readonly TimelineBlock[];
		weekHref: (week: number) => string;
		onweek: (week: number) => void;
		onclose: () => void;
		/** The season, on its way: null when there is none or its read failed. */
		road: Promise<SeasonView | null>;
		/** The goals each block's lanes list, held while the season streams. */
		openGoals: number;
	}

	let {
		open = $bindable(),
		title,
		blocks,
		weekHref,
		onweek,
		onclose,
		road,
		openGoals
	}: Props = $props();

	/** The road's answer, beside the promise it answers (a new week's data brings a new one). */
	let arrived = $state<[Promise<SeasonView | null>, SeasonView | null]>();
	$effect(() => {
		const from = road;
		const answer = (season: SeasonView | null) => road === from && (arrived = [from, season]);
		from.then(answer, () => answer(null));
	});
	/** The season; null when there is none; undefined while it streams. */
	const season = $derived(arrived?.[0] === road ? arrived[1] : undefined);

	function go(event: MouseEvent, week: number) {
		if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
			return;
		event.preventDefault();
		open = false;
		onweek(week);
	}
</script>

<BottomSheet bind:open title="Your plan" description={title} {onclose} data-testid="plan-sheet">
	<!-- Outside the region: a busy region's changes may go unannounced. -->
	<p class="visually-hidden" role="status">{season === undefined ? 'Loading your season' : ''}</p>
	<section aria-label="Your season" aria-busy={season === undefined}>
		<BlockTimeline
			{blocks}
			{weekHref}
			onweek={go}
			season={season === null ? undefined : (season ?? null)}
			lanes={openGoals}
			data-testid="block-timeline"
		/>
	</section>
</BottomSheet>
