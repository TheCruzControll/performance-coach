<!--
  @component
  The header's stopwatch for the workout shown: this device's, or, before this device has started
  one, the time since the workout started. Loaded with the view, never in the first render.
-->
<script lang="ts">
	import type { WorkoutView } from '#lib/domain/workout/index.ts';
	import { startStopwatch } from '#lib/domain/workout/timers.ts';
	import Stopwatch from '#lib/ui/workout/Stopwatch.svelte';

	let { view }: { view: WorkoutView } = $props();

	const stopwatch = $derived(
		view.device.stopwatch.startedAt === null
			? startStopwatch(Date.parse(view.workout.startedAt))
			: view.device.stopwatch
	);
</script>

<Stopwatch {stopwatch} />
