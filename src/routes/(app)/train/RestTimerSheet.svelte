<!--
  @component
  Train's standalone rest timer (PRD §8, Train → Tools; Instrument v2, Paper 4 · Train "Start a
  rest" and "Resting"): a rest between sets that belongs to no workout and opens none. "Rest for"
  lists a rest per exercise type at the length the workout settings give it (settings.ts); one tap
  starts it. Resting, the sheet is titled by the rest's class, with the time in 112 px numerals,
  how long the rest is, Add 30 seconds, Pause (Resume), Start over and Done resting, which forgets
  it and closes the sheet. With the sheet closed a kept rest is one quiet line on Train ("Resting
  2:14"), the last row of the column, which opens the sheet again. It runs on timestamps this
  device keeps (standalone-rest.ts, with its class), read at each whole second on the screen's
  clock (clock.ts), so a reload, a closed tab or another tab shows exactly the right time. At zero
  it vibrates and sounds as the settings allow, and keeps the screen awake during rest when they
  ask for it (feedback.ts), while Train is open. Train imports this on first intent, or as it
  mounts when a rest is stored, so a running rest shows again after a reload or a return to Train.
  The workout's own rest is RestTimer.svelte, until v2/10.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { createTone, createWakeLock, vibrate } from '#lib/client/workout/feedback.ts';
	import { readWorkoutSettings } from '#lib/client/workout/settings.ts';
	import {
		readStandaloneRest,
		STANDALONE_REST_KEY,
		writeStandaloneRest,
		type StandaloneRest
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
	import Icon from '#lib/ui/components/Icon.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import { clock } from '#lib/ui/workout/clock.ts';
	import {
		readRest,
		REST_CLASS_WORDS,
		restAnchor,
		restCaption,
		restLineLabel,
		restTitle
	} from '#lib/ui/workout/rest-words.ts';

	interface Props {
		open: boolean;
		onclose?: () => void;
	}

	let { open = $bindable(), onclose }: Props = $props();

	let rest = $state.raw<StandaloneRest | null>(readStandaloneRest(Date.now()));
	let lengths = $state.raw(readWorkoutSettings().rest);
	let notSaved = $state(false);
	let now = $state(Date.now());

	// Read again on each opening: the settings, or another tab's rest, may have changed.
	$effect(() => {
		if (!open) return;
		lengths = readWorkoutSettings().rest;
		rest = readStandaloneRest(Date.now());
	});

	// Ticks on the whole seconds the time turns over on, leading the screen's clock; a paused rest
	// shows no change. No progress bar: Paper draws none.
	$effect(() => {
		const current = rest;
		now = Date.now();
		if (!current || current.pausedAt !== null) return;
		return clock.join({ anchor: restAnchor(current), lead: true, tick: (at) => (now = at) });
	});

	// Back on the page (a locked phone, another app), the time is read again at once.
	$effect(() => {
		const back = () => {
			if (document.visibilityState === 'visible') now = Date.now();
		};
		document.addEventListener('visibilitychange', back);
		return () => document.removeEventListener('visibilitychange', back);
	});

	const reading = $derived(rest ? readRest(rest, now) : null);
	const over = $derived(reading?.phase === 'over');
	const paused = $derived(reading?.phase === 'paused');

	function keep(next: StandaloneRest | null) {
		rest = next;
		notSaved = !writeStandaloneRest(next);
	}

	/** A timer control, now: the rest keeps its class. */
	const act = (change: (rest: RestState, now: number) => RestState) => () => {
		if (rest) keep({ ...change(rest, Date.now()), restClass: rest.restClass });
	};

	/**
	 * Done resting: the sheet closes, and the rest is forgotten once it has closed, so the sheet keeps
	 * its last reading while it slides away. Its opener gives the focus back when it is still there
	 * (More's row); the line on Train goes with the rest, so then the focus goes to More's row if More
	 * is open, or to More on Train.
	 */
	function done() {
		open = false;
		onclose?.();
		document.querySelector('[data-testid="rest-timer-sheet"]')?.addEventListener(
			'close',
			async () => {
				keep(null);
				// The line on Train goes once Svelte has drawn the rest away: read the focus after that.
				await tick();
				const at = document.activeElement;
				if (at && at !== document.body) return;
				const row = document.querySelector<HTMLElement>('[data-testid="open-rest-timer"]');
				const next = row?.checkVisibility?.()
					? row
					: document.querySelector<HTMLElement>('[data-testid="open-more"]');
				next?.focus();
			},
			{ once: true }
		);
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

{#snippet none()}{/snippet}

<!-- The one line on Train (Paper: "Closed, it is one line on the week"), where Train places this
     component: the column's last row. It stays while its sheet is open, so the sheet gives the
     focus back to it. -->
{#if reading}
	<button
		type="button"
		class="line"
		aria-haspopup="dialog"
		onclick={() => (open = true)}
		data-testid="train-rest"
	>
		<span>
			{restLineLabel(reading)}
			<span class="clock" data-testid="rest-time">{reading.time}</span>{over ? ' ago' : ''}
		</span>
		<Icon name="chevron-right" size={14} class="chevron" />
	</button>
{/if}

<BottomSheet
	bind:open
	title={rest ? restTitle(rest.restClass) : 'Rest for'}
	{onclose}
	data-testid="rest-timer-sheet"
>
	{#if reading}
		<section
			class="resting"
			aria-label="Rest timer"
			data-phase={reading.phase}
			data-testid="rest-timer"
		>
			<p
				class="time"
				role={over ? undefined : 'timer'}
				aria-label={over ? undefined : 'Rest left'}
				data-testid="rest-time"
			>
				{reading.time}
			</p>
			<p class="caption">{restCaption(reading)}</p>
			<ul class="rows" role="list">
				<li>
					<ListRow
						title="Add 30 seconds"
						onclick={act((r, at) => addRest(r, at))}
						trailing={none}
						data-testid="rest-add"
					/>
				</li>
				{#if !over}
					<li>
						<ListRow
							title={paused ? 'Resume' : 'Pause'}
							onclick={act(paused ? resumeRest : pauseRest)}
							trailing={none}
							data-testid="rest-pause"
						/>
					</li>
				{/if}
				<li>
					<ListRow
						title="Start over"
						onclick={act(resetRest)}
						trailing={none}
						data-testid="rest-reset"
					/>
				</li>
			</ul>
			<div class="done">
				<Button variant="secondary" size="lg" block onclick={done} data-testid="rest-done">
					Done resting
				</Button>
			</div>
			<span class="visually-hidden" role="status">{over ? 'Rest over' : ''}</span>
		</section>
	{:else}
		<ul class="rows" role="list">
			{#each REST_CLASS_WORDS as row (row.restClass)}
				{@const seconds = lengths[row.restClass]}
				<li>
					<ListRow
						title={row.label}
						value={formatDuration(seconds)}
						trailing={none}
						onclick={() =>
							keep({ ...startRest(Date.now(), seconds * 1000), restClass: row.restClass })}
						data-testid="start-{row.restClass}-rest"
					/>
				</li>
			{/each}
		</ul>
		<p class="foot">One tap starts it. Lengths come from your workout settings.</p>
	{/if}
	{#if notSaved}
		<p class="not-saved" role="status" data-testid="rest-not-saved">
			Not kept on this phone: the timer runs while Train is open, but a reload loses it.
		</p>
	{/if}
</BottomSheet>

<!-- Scoped, as MoreSheet's: Train's budget is checked in CI (pnpm budgets). -->
<style>
	/* As Train's quiet rows (More, the week's line): 15/22 secondary, the chevron tertiary, a 60 px
	   row with a hairline above from 1024 px. */
	.line {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
		width: 100%;
		min-height: var(--touch-target);
		margin-top: var(--space-3-5);
		font: var(--type-secondary);
		color: var(--color-text-secondary);
		text-align: start;
	}

	.line :global(.chevron) {
		flex: none;
		color: var(--color-text-tertiary);
	}

	.clock {
		font-variant-numeric: tabular-nums;
	}

	@media (hover: hover) and (pointer: fine) {
		.line:hover {
			color: var(--color-text);
		}
	}

	@media (width >= 64rem) {
		.line {
			min-height: 3.75rem;
			margin-top: 0;
			border-top: 1px solid var(--color-hairline);
		}
	}

	/* Paper, "Resting": the time 112/116 in 600, then how long it is, 4 px under it. */
	.time {
		font: var(--type-numeral-xl);
		line-height: 1.0357;
		letter-spacing: var(--tracking-hero);
		font-variant-numeric: lining-nums tabular-nums;
		color: var(--color-text);
	}

	/* The resting block measures its own width. In a narrow one (a 320 px phone), 'mm:ss' at 112 px
	   would outgrow its 264 px, so the time steps down to 64 px. */
	.resting {
		container-type: inline-size;
	}

	@container (width < 19rem) {
		.time {
			font-size: var(--text-6xl);
		}
	}

	.resting[data-phase='paused'] .time {
		color: var(--color-text-secondary);
	}

	.caption {
		padding-top: var(--space-1);
		font: var(--type-body);
		color: var(--color-text-secondary);
	}

	.rows {
		display: grid;
		list-style: none;
	}

	.resting .rows {
		margin-top: var(--space-7);
	}

	.done {
		display: grid;
		margin-top: var(--space-5);
	}

	.foot {
		padding-top: var(--space-4);
		font: var(--type-secondary);
		color: var(--color-text-tertiary);
	}

	/* Its words say why. */
	.not-saved {
		padding-top: var(--space-4);
		font: var(--type-secondary);
		color: var(--color-warning);
	}
</style>
