<!--
  @component
  The run's Status Display (Graphite 2004 only, through StatusSlot.svelte): the segment on screen
  and the run's pace, from what the run view shows (run-status.ts).
-->
<script lang="ts">
	import StatusDisplay from '#lib/ui/components/StatusDisplay.svelte';
	import { runStatus, type RunStatusInput } from './run-status.ts';

	let { input }: { input: RunStatusInput } = $props();
</script>

<StatusDisplay {...runStatus(input)} data-testid="run-status" />
