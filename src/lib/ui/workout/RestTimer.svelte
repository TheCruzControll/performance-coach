<!--
  @component
  The rest timer (PRD §8): the time left in big tabular numerals over a progress bar, read from
  the rest's timestamps (timers.ts, rest-words.ts) at each whole second, so it is exact after a
  refresh or a closed tab. Running: Pause, Reset, +30 s and Skip. Paused: Resume in their place.
  Once over it counts up, 'Rest over · 0:42 ago', in the accent, with +30 s and Dismiss; a polite
  status says 'Rest over' as it ends. The screen places it and does what each control asks;
  everything said is in rest-words.ts. Graphite 2004 shows it as its Status Display (graphite.css,
  the `rest` hook): the time left as the big numeral on the readout, the controls beneath it.
-->
<script lang="ts">
	import type { RestState } from '#lib/domain/workout/types.ts';
	import Button from '../components/Button.svelte';
	import IconButton from '../components/IconButton.svelte';
	import { msToNextTick, readRest } from './rest-words.ts';

	interface Props {
		rest: RestState;
		onpause: () => void;
		onresume: () => void;
		onreset: () => void;
		/** +30 s. */
		onadd: () => void;
		/** Skip, or Dismiss once over: no rest on screen. */
		onclear: () => void;
	}

	let { rest, onpause, onresume, onreset, onadd, onclear }: Props = $props();

	let now = $state(Date.now());

	// Ticks on the whole seconds the time turns over on; a paused rest shows no change.
	$effect(() => {
		const current = rest;
		now = Date.now();
		if (current.pausedAt !== null) return;
		let timer: ReturnType<typeof setTimeout>;
		const tick = () => {
			now = Date.now();
			timer = setTimeout(tick, msToNextTick(current, now));
		};
		timer = setTimeout(tick, msToNextTick(current, now));
		return () => clearTimeout(timer);
	});

	const reading = $derived(readRest(rest, now));
	const over = $derived(reading.phase === 'over');
	const paused = $derived(reading.phase === 'paused');
</script>

<section
	class="rest"
	data-ui="rest"
	aria-label="Rest timer"
	data-phase={reading.phase}
	data-testid="rest-timer"
>
	<div class="reading">
		{#if over}
			<p class="time over" data-testid="rest-time">
				{reading.label} · <span class="tabular">{reading.time}</span> ago
			</p>
		{:else}
			<span class="eyebrow">{reading.label} · {reading.total}</span>
			<span class="time tabular" role="timer" aria-label="Rest left" data-testid="rest-time">
				{reading.time}
			</span>
		{/if}
	</div>
	<div class="controls">
		{#if !over}
			<!-- One button that changes, so the focus stays on it. -->
			<IconButton
				icon={paused ? 'play' : 'pause'}
				label={paused ? 'Resume rest' : 'Pause rest'}
				variant={paused ? 'accent' : 'filled'}
				onclick={paused ? onresume : onpause}
			/>
			<IconButton icon="refresh" label="Reset rest" variant="filled" onclick={onreset} />
		{/if}
		<Button variant="secondary" onclick={onadd}>+30 s</Button>
		<Button variant="ghost" onclick={onclear}>{over ? 'Dismiss' : 'Skip'}</Button>
	</div>
	<div class="track" aria-hidden="true">
		<div class="fill" style:transform="scaleX({reading.progress})"></div>
	</div>
	<span class="visually-hidden" role="status">{over ? 'Rest over' : ''}</span>
</section>

<style>
	.rest {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
		padding: var(--space-3);
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-border);
		background: var(--color-surface-2);
		box-shadow: var(--elevation-2);
	}

	.rest[data-phase='over'] {
		border-color: color-mix(in srgb, var(--color-accent-text) 45%, transparent);
		background: color-mix(in srgb, var(--color-accent-subtle) 60%, var(--color-surface-2));
	}

	.reading {
		display: grid;
		min-width: 0;
	}

	.time {
		font-size: var(--text-3xl);
		font-weight: var(--weight-bold);
		line-height: var(--leading-tight);
		color: var(--color-text);
	}

	.rest[data-phase='paused'] .time {
		color: var(--color-text-secondary);
	}

	.time.over {
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
		color: var(--color-accent-text);
	}

	/* Tight, so the time and its 44 px controls share one row at 393 px: a short pill. */
	.controls {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		margin-left: auto;
	}

	.controls > :global(.btn) {
		--btn-pad: var(--space-3);
	}

	.track {
		flex-basis: 100%;
		height: 4px;
		border-radius: var(--radius-full);
		background: var(--color-surface-3);
		overflow: hidden;
	}

	.fill {
		height: 100%;
		background: var(--color-accent);
		transform-origin: left;
	}

	.rest[data-phase='paused'] .fill {
		background: var(--color-text-tertiary);
	}
</style>
