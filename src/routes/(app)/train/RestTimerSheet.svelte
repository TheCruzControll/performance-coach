<!--
  @component
  Train's standalone rest timer (PRD §8, Train → Tools): a rest between sets that belongs to no
  workout and opens none. The sheet offers a rest per exercise type, at the lengths the workout
  settings give them (settings.ts); one tap starts it. It is the workout's rest timer
  (RestTimer.svelte over timers.ts) on timestamps this device keeps (standalone-rest.ts), so a
  reload, a closed tab or another tab shows exactly the right time. With the sheet closed, a
  running rest shows under its Tools row with the same controls. At zero it vibrates and sounds
  as the settings allow, and keeps the screen awake during rest when they ask for it
  (feedback.ts). Train imports this on first intent, or on arrival when the device holds a rest.
-->
<script lang="ts">
	import { createTone, createWakeLock, vibrate } from '#lib/client/workout/feedback.ts';
	import { readWorkoutSettings } from '#lib/client/workout/settings.ts';
	import {
		readStandaloneRest,
		STANDALONE_REST_KEY,
		writeStandaloneRest
	} from '#lib/client/workout/standalone-rest.ts';
	import { formatDuration } from '#lib/domain/units.ts';
	import {
		addRest,
		pauseRest,
		resetRest,
		restDone,
		restRemaining,
		resumeRest,
		startRest
	} from '#lib/domain/workout/timers.ts';
	import type { RestState } from '#lib/domain/workout/types.ts';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import RestTimer from '#lib/ui/workout/RestTimer.svelte';
	import { REST_CLASS_WORDS } from '#lib/ui/workout/rest-words.ts';
	import { tick } from 'svelte';

	interface Props {
		open: boolean;
		onclose?: () => void;
	}

	let { open = $bindable(), onclose }: Props = $props();

	let rest = $state.raw<RestState | null>(readStandaloneRest(Date.now()));
	let lengths = $state.raw(readWorkoutSettings().rest);
	let notSaved = $state(false);
	let presets = $state<HTMLElement>();

	// Read again on each opening: the settings, or another tab's rest, may have changed.
	$effect(() => {
		if (!open) return;
		lengths = readWorkoutSettings().rest;
		rest = readStandaloneRest(Date.now());
	});

	function keep(next: RestState | null) {
		rest = next;
		notSaved = !writeStandaloneRest(next);
	}

	/** A timer control, now. */
	const act = (change: (rest: RestState, now: number) => RestState) => () => {
		if (rest) keep(change(rest, Date.now()));
	};

	/** Skip, or Dismiss once over: the focus moves on to what starts the next rest. */
	async function clear() {
		keep(null);
		await tick();
		const next = open
			? presets?.querySelector('button')
			: document.querySelector<HTMLElement>('[data-testid="open-rest-timer"]');
		next?.focus();
	}

	// The tone listens for the page's next tap, which browsers ask before it may sound.
	const tone = createTone();
	const wakeLock = createWakeLock();
	$effect(() => () => {
		tone.dispose();
		void wakeLock.release();
	});

	// Awake during rest when the settings ask; at zero, the vibration and the tone they allow. Only
	// a rest that ends while Train is open: one that ended meanwhile says so on screen.
	$effect(() => {
		const current = rest;
		const now = Date.now();
		const resting = current !== null && !restDone(current, now);
		if (resting && readWorkoutSettings().keepAwake) void wakeLock.acquire();
		else void wakeLock.release();
		if (!resting || current.pausedAt !== null) return;
		const timer = setTimeout(
			() => {
				const settings = readWorkoutSettings();
				if (settings.vibration) vibrate();
				if (settings.sound) tone.play();
				void wakeLock.release();
			},
			restRemaining(current, now)
		);
		return () => clearTimeout(timer);
	});
</script>

<svelte:window
	onstorage={(event) => {
		if (event.key === STANDALONE_REST_KEY) rest = readStandaloneRest(Date.now());
	}}
/>

{#snippet timer(current: RestState)}
	<RestTimer
		rest={current}
		onpause={act(pauseRest)}
		onresume={act(resumeRest)}
		onreset={act(resetRest)}
		onadd={act((r, now) => addRest(r, now))}
		onclear={clear}
	/>
{/snippet}

{#if rest && !open}
	<div data-testid="train-rest">{@render timer(rest)}</div>
{/if}

<BottomSheet
	bind:open
	title="Rest timer"
	description="Keeps time on this device, even after a reload."
	{onclose}
	data-testid="rest-timer-sheet"
>
	<div class="body">
		{#if rest}
			{@render timer(rest)}
		{:else}
			<p class="lead">Pick a rest to start it. Your workout settings set each length.</p>
			<div class="presets" bind:this={presets}>
				{#each REST_CLASS_WORDS as row (row.restClass)}
					{@const seconds = lengths[row.restClass]}
					<Button
						block
						variant="secondary"
						icon="play"
						onclick={() => keep(startRest(Date.now(), seconds * 1000))}
						data-testid="start-{row.restClass}-rest">{row.label} · {formatDuration(seconds)}</Button
					>
				{/each}
			</div>
		{/if}
		{#if notSaved}
			<Notice tone="warning" title="Not kept on this device" data-testid="rest-not-saved">
				The timer runs while Train is open, but a reload loses it.
			</Notice>
		{/if}
	</div>
</BottomSheet>

<style>
	.body {
		display: grid;
		gap: var(--space-4);
	}

	.lead {
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
		color: var(--color-text-secondary);
	}

	/* One per row on a phone; two side by side where the dialog has room (desktop). */
	.presets {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
		gap: var(--space-2);
	}
</style>
