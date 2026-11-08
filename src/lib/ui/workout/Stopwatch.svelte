<!--
  @component
  The workout's running time, pauses left out (timers.ts), ticking once a second while it runs. A
  timer role, which is not announced every second. With its handlers, its controls beside it:
  Pause while it runs; Resume and Reset once paused, the time dimmed and called paused. Each is
  36 px with a 44 px hit area, so the header's row keeps its height.
-->
<script lang="ts">
	import { formatDuration } from '#lib/domain/units.ts';
	import { stopwatchElapsed } from '#lib/domain/workout/timers.ts';
	import type { StopwatchState } from '#lib/domain/workout/index.ts';
	import Icon from '../components/Icon.svelte';
	import IconButton from '../components/IconButton.svelte';

	interface Props {
		stopwatch: StopwatchState;
		label?: string;
		onpause?: () => void;
		onresume?: () => void;
		onreset?: () => void;
	}

	let { stopwatch, label = 'Workout time', onpause, onresume, onreset }: Props = $props();

	let now = $state(Date.now());

	$effect(() => {
		now = Date.now();
		if (stopwatch.runningSince === null) return;
		const tick = setInterval(() => (now = Date.now()), 1000);
		return () => clearInterval(tick);
	});

	const elapsed = $derived(formatDuration(Math.floor(stopwatchElapsed(stopwatch, now) / 1000)));
	const paused = $derived(stopwatch.runningSince === null);
</script>

<span class="clock">
	<span
		class="stopwatch"
		role="timer"
		aria-label={paused ? `${label}, paused` : label}
		data-paused={paused ? '' : undefined}
		data-testid="stopwatch"
	>
		<Icon name="clock" size={16} />
		<span class="time">{elapsed}</span>
	</span>
	{#if onpause && onresume}
		<!-- One button that changes, so the focus stays on it. -->
		<IconButton
			icon={paused ? 'play' : 'pause'}
			label={paused ? 'Resume workout time' : 'Pause workout time'}
			size="sm"
			onclick={paused ? onresume : onpause}
		/>
	{/if}
	{#if paused && onreset}
		<IconButton icon="refresh" label="Reset workout time" size="sm" onclick={onreset} />
	{/if}
</span>

<style>
	.clock {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
	}

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

	.stopwatch[data-paused] .time {
		color: var(--color-text-secondary);
	}
</style>
