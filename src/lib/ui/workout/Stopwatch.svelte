<!--
  @component
  The workout's running time, pauses left out (timers.ts): display only, ticking once a second
  while it runs. rest-timer adds its controls. A timer role, which is not announced every second.
-->
<script lang="ts">
	import { formatDuration } from '#lib/domain/units.ts';
	import { stopwatchElapsed } from '#lib/domain/workout/timers.ts';
	import type { StopwatchState } from '#lib/domain/workout/index.ts';
	import Icon from '../components/Icon.svelte';

	interface Props {
		stopwatch: StopwatchState;
		label?: string;
	}

	let { stopwatch, label = 'Workout time' }: Props = $props();

	let now = $state(Date.now());

	$effect(() => {
		now = Date.now();
		if (stopwatch.runningSince === null) return;
		const tick = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(tick);
	});

	const elapsed = $derived(formatDuration(Math.floor(stopwatchElapsed(stopwatch, now) / 1000)));
</script>

<span class="stopwatch" role="timer" aria-label={label} data-testid="stopwatch">
	<Icon name="clock" size={16} />
	<span class="time">{elapsed}</span>
</span>

<style>
	.stopwatch {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1-5);
		min-height: 2rem;
		padding: var(--space-1) var(--space-3);
		border-radius: var(--radius-full);
		background: var(--color-surface-2);
		border: 1px solid var(--color-border);
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}

	.time {
		color: var(--color-text);
		font-variant-numeric: tabular-nums;
	}
</style>
