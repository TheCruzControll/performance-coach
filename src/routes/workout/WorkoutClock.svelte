<!--
  @component
  The header's stopwatch for the workout shown: this device's, or, before this device has started
  one, the time since the workout started. Loaded with the view, never in the first render. It
  can be paused, resumed and reset: device actions, stored with the workout, so a reload keeps
  them. A tap before the store is open (right after the first paint) waits for it, and is decided
  then, on the workout as the store has it, at the time of the tap. One this device never
  started starts from the workout's start first. Paused, the time opens a sheet with Resume and
  Reset, so the header holds one control and keeps its geometry in both states. The sheet loads
  once the first frame has painted, so the first paint waits for the stopwatch alone; a tap
  before then opens it as it arrives.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import type { ChunkLoad, StoreWrite } from '#lib/client/workout/active.svelte.ts';
	import type { LocalAction, WorkoutView } from '#lib/domain/workout/index.ts';
	import { startStopwatch } from '#lib/domain/workout/timers.ts';
	import type BottomSheetComponent from '#lib/ui/components/BottomSheet.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import Stopwatch from '#lib/ui/workout/Stopwatch.svelte';
	import { afterPaint } from './lazy.ts';

	interface Props {
		view: WorkoutView;
		/** Writes through the page's store, now or once it opens (ActiveWorkout.write). */
		write: StoreWrite;
		/** The page's chunk loader, for the sheet. */
		load: ChunkLoad;
	}

	let { view, write, load }: Props = $props();

	let BottomSheet = $state.raw<typeof BottomSheetComponent | null>(null);
	onMount(() =>
		afterPaint(() => {
			void load(() => import('#lib/ui/components/BottomSheet.svelte')).then((module) => {
				if (module) BottomSheet = module.default;
			});
		})
	);

	const started = $derived(Date.parse(view.workout.startedAt));
	const stopwatch = $derived(
		view.device.stopwatch.startedAt === null ? startStopwatch(started) : view.device.stopwatch
	);

	function act(type: 'stopwatch.pause' | 'stopwatch.resume' | 'stopwatch.reset') {
		const workoutId = view.workout.id;
		const action: LocalAction = { type, workoutId, at: Date.now() };
		write((store) => {
			if (view.device.stopwatch.startedAt !== null) store.dispatch(action);
			else store.dispatch({ type: 'stopwatch.start', workoutId, at: started }, action);
		});
	}

	let options = $state(false);
	function choose(type: 'stopwatch.resume' | 'stopwatch.reset') {
		act(type);
		options = false;
	}
</script>

<!-- Its controls show from the first render, so the header never shifts when the store opens. -->
<Stopwatch {stopwatch} onpause={() => act('stopwatch.pause')} onoptions={() => (options = true)} />
{#if BottomSheet}
	<BottomSheet bind:open={options} title="Workout time paused" data-testid="stopwatch-sheet">
		{#snippet footer()}
			<div class="actions">
				<Button block icon="play" onclick={() => choose('stopwatch.resume')}
					>Resume workout time</Button
				>
				<Button block variant="danger" icon="refresh" onclick={() => choose('stopwatch.reset')}
					>Reset workout time</Button
				>
			</div>
		{/snippet}
		<p class="note">Reset sets the time back to 0:00.</p>
	</BottomSheet>
{/if}

<style>
	.note {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.actions {
		display: grid;
		gap: var(--space-2);
	}
</style>
