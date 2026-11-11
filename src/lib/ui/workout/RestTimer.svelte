<!--
  @component
  The rest timer (PRD §8): the time left in big tabular numerals over a progress bar, read from
  the rest's timestamps (timers.ts, rest-words.ts) at each whole second, on the screen's one clock
  (clock.ts), so it is exact after a refresh or a closed tab and the stopwatch changes on the same
  frame. The bar is one CSS animation over the rest's whole length, started as far in as the rest
  has run (restBar): it fills continuously on the compositor with no JavaScript per frame, stands
  still while paused, and starts again from the timestamps on each change and each return to the
  page. With motion reduced it steps once a second instead. Over, it keeps the running height,
  so nothing around it moves. Running: Pause, Reset, +30 s and Skip. Paused: Resume in their place.
  Once over it counts up, 'Rest over · 0:42 ago', in the accent, with +30 s and Dismiss; a polite
  status says 'Rest over' as it ends. The screen places it and does what each control asks;
  everything said is in rest-words.ts.
-->
<script lang="ts">
	import type { RestState } from '#lib/domain/workout/types.ts';
	import Button from '../components/Button.svelte';
	import IconButton from '../components/IconButton.svelte';
	import { untrack } from 'svelte';
	import { clock } from './clock.ts';
	import { readRest, restAnchor, restBar } from './rest-words.ts';

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

	// Ticks on the whole seconds the time turns over on, leading the screen's clock; a paused rest
	// shows no change.
	$effect(() => {
		const current = rest;
		now = Date.now();
		if (current.pausedAt !== null) return;
		return clock.join({ anchor: restAnchor(current), lead: true, tick: (at) => (now = at) });
	});

	const reading = $derived(readRest(rest, now));
	const over = $derived(reading.phase === 'over');
	const paused = $derived(reading.phase === 'paused');

	// Back on the page (a locked phone, another app), the bar starts again from the timestamps:
	// the animation's timeline may have stood still meanwhile.
	let returns = $state(0);
	$effect(() => {
		const back = () => {
			if (document.visibilityState === 'visible') returns += 1;
		};
		document.addEventListener('visibilitychange', back);
		return () => document.removeEventListener('visibilitychange', back);
	});

	/** What starts the bar's animation again: a change of the rest, its phase, or a return. */
	const barKey = $derived(
		`${rest.startedAt}:${rest.durationMs}:${rest.addedMs}:${rest.pausedAt}:${reading.phase}:${returns}`
	);
	const bar = $derived.by(() => {
		void barKey;
		return untrack(() => restBar(rest, Date.now()));
	});
</script>

<section class="rest" aria-label="Rest timer" data-phase={reading.phase} data-testid="rest-timer">
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
		{#key barKey}
			<div
				class="fill"
				data-testid="rest-bar"
				style:--progress={reading.progress}
				style:animation-duration="{bar.durationMs}ms"
				style:animation-delay="{bar.delayMs}ms"
				style:animation-play-state={bar.running ? 'running' : 'paused'}
			></div>
		{/key}
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

	/* The eyebrow over the time: over, its one line keeps that height, so the pill never moves. */
	.reading {
		display: grid;
		align-content: center;
		min-width: 0;
		min-height: calc(
			var(--text-2xs) * var(--leading-normal) + var(--text-3xl) * var(--leading-tight)
		);
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

	/* Empty to full over the rest (its duration, delay and play state set inline): a transform,
	   so the compositor runs it. */
	.fill {
		height: 100%;
		background: var(--color-accent);
		transform-origin: left;
		animation-name: fill;
		animation-timing-function: linear;
		animation-fill-mode: both;
	}

	@keyframes fill {
		from {
			transform: scaleX(0);
		}
		to {
			transform: scaleX(1);
		}
	}

	/* Reduced motion: no animation; the bar steps to the reading's progress once a second. */
	@media (prefers-reduced-motion: reduce) {
		.fill {
			animation-name: none;
			transform: scaleX(var(--progress));
		}
	}

	.rest[data-phase='paused'] .fill {
		background: var(--color-text-tertiary);
	}
</style>
