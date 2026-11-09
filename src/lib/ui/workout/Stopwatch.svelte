<!--
  @component
  The workout's running time, pauses left out (timers.ts), ticking once a second while it runs. A
  timer role, which is not announced every second. With its handlers, the time itself is the
  Pause button while it runs; once paused (the time dimmed and called paused) it opens Resume and
  Reset (onoptions), so the header never gains a control. The button lies over the time, 44 px
  tall, so the time keeps its width and the header's row its height in both states.
-->
<script lang="ts">
	import { formatDuration } from '#lib/domain/units.ts';
	import { stopwatchElapsed } from '#lib/domain/workout/timers.ts';
	import type { StopwatchState } from '#lib/domain/workout/index.ts';
	import Icon from '../components/Icon.svelte';

	interface Props {
		stopwatch: StopwatchState;
		label?: string;
		onpause?: () => void;
		/** Paused, the time opens Resume and Reset. */
		onoptions?: () => void;
	}

	let { stopwatch, label = 'Workout time', onpause, onoptions }: Props = $props();

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
	<span class="face">
		<span
			class="stopwatch"
			role="timer"
			aria-label={paused ? `${label}, paused` : label}
			data-paused={paused ? '' : undefined}
			data-testid="stopwatch"
		>
			<Icon name={!onpause ? 'clock' : paused ? 'play' : 'pause'} size={16} />
			<span class="time">{elapsed}</span>
		</span>
		{#if onpause && onoptions}
			<!-- One button that changes, so the focus stays on it. -->
			<button
				type="button"
				class="toggle"
				aria-label={paused ? 'Workout time paused: resume or reset' : 'Pause workout time'}
				aria-haspopup={paused ? 'dialog' : undefined}
				onclick={paused ? onoptions : onpause}
			></button>
		{/if}
	</span>
</span>

<style>
	.clock {
		display: inline-flex;
		align-items: center;
	}

	.face {
		position: relative;
		display: inline-flex;
	}

	.toggle {
		position: absolute;
		inset: 50% 0 auto;
		height: var(--touch-target);
		translate: 0 -50%;
		/* Its hover paints the time's pill only, not the whole 44 px. */
		padding-block: calc((var(--touch-target) - 2rem) / 2);
		background-clip: content-box;
		border-radius: var(--radius-full);
	}

	@media (hover: hover) and (pointer: fine) {
		.toggle:hover {
			background-color: color-mix(in srgb, var(--color-text) 8%, transparent);
		}
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
