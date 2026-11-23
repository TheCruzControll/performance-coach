<!--
  @component
  The resume line (resume.ts decides what it offers and its words): loaded by the app shell on
  idle, never in the first render, and drawn only when there is something to offer. One plain
  row on the canvas, 44 px with 12 px below it (Paper, 3 · Today: "The floating bar became one
  line, on every tab"): screen chrome on the tab bar's hairline below 1024 px, at the bottom of
  the column beside the rail from there. Its height is --resume-inset, which --nav-inset-bottom
  includes (tokens.css), so the shell's bottom padding and every other bottom chrome clear it and
  it covers nothing.
  - Resume {title}, a link to the kind's page, then the time, the sync pill and a chevron.
  - N changes waiting to sync, with the pill: a link to History. While changes wait (here or in a
    workout in progress), the screen's sync engine runs, so they sync from any tab.
  - {title} is in progress on another device, and Continue here (Today only, online, nothing on
    this device): builds the other device's workout here, then opens its page.
  A screen that draws the workout in progress itself claims it (resume-state.svelte.ts), and the
  line then shows only changes waiting there. It looks again on every screen change, when the
  page becomes visible again, and once the engine has synced everything. data-looked names the
  screen it last looked for.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { deviceWorkout } from '#lib/client/workout/device-workout.svelte.ts';
	import { workoutPath } from '#lib/client/workout/kinds.ts';
	import type { OutboxStatus } from '#lib/client/workout/outbox-rules.ts';
	import { outboxStatus } from '#lib/client/workout/status.svelte.ts';
	import { startStopwatch } from '#lib/domain/workout/timers.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import Stopwatch from '#lib/ui/workout/Stopwatch.svelte';
	import SyncPill from '#lib/ui/workout/SyncPill.svelte';
	import {
		continueHereFlow,
		findResume,
		hasPending,
		lineFor,
		NOTHING,
		REMOTE_CHECK_PATHS,
		shownFor,
		syncFromHere,
		type Resume
	} from './resume.ts';
	import { resumeState } from './resume-state.svelte.ts';

	let { pathname }: { pathname: string } = $props();

	let found = $state.raw<Resume>(NOTHING);
	/** What it found, for this line and for a screen that claims the workout in progress. */
	function settle(next: Resume) {
		found = next;
		resumeState.found = next;
	}
	/**
	 * The remote offer belongs to its screen: it never follows the owner to another tab. A screen
	 * that claims the workout in progress draws it itself.
	 */
	const resume = $derived(
		shownFor(
			found.type === 'remote' && !REMOTE_CHECK_PATHS.includes(pathname) ? NOTHING : found,
			resumeState.claimed,
			pathname
		)
	);
	const line = $derived(lineFor(resume, resumeState.failed));

	/** The screen it last looked for, once it has: what the specs wait for. */
	let looked = $state<string | null>(null);
	async function look(path: string) {
		const next = await findResume(path);
		if (path !== pathname) return;
		settle(next);
		deviceWorkout.active =
			next.type === 'active'
				? {
						plannedLineage: next.workout.plannedLineage,
						href: resolve(workoutPath(next.workout.kind))
					}
				: null;
		looked = path;
	}
	$effect(() => void look(pathname));
	// Back to the app (another tab may have started or finished a workout): look again.
	onMount(() => {
		const again = () => document.visibilityState === 'visible' && void look(pathname);
		document.addEventListener('visibilitychange', again);
		return () => document.removeEventListener('visibilitychange', again);
	});

	// ---- This screen's sync engine, while changes wait ----------------------------------------

	let starting = false;
	let gone = false;
	/** The running engine's stop; null while none runs. */
	let engine = $state.raw<(() => void) | null>(null);
	$effect(() => {
		if (starting || !hasPending(found)) return;
		starting = true;
		void syncFromHere().then((stop) => {
			if (gone) stop?.();
			else if (stop) engine = stop;
			else starting = false; // this browser cannot keep a workout: nothing to send from
		});
	});
	onMount(() => () => {
		gone = true;
		engine?.();
		// It is gone from the shell (the workout screen sits outside it): a session finished or
		// discarded there must not read Resume when the shell comes back before it looks again.
		deviceWorkout.active = null;
		resumeState.found = NOTHING;
		resumeState.continuing = false;
		resumeState.failed = false;
	});

	const SAVED: OutboxStatus = { state: 'synced' };
	const status = $derived(
		engine
			? outboxStatus.current
			: resume.type === 'active' && resume.workout.pending === 0
				? SAVED
				: null
	);
	// Everything sent: the waiting offer goes, and the active one counts again.
	$effect(() => {
		if (status?.state === 'synced' && hasPending(found)) void look(pathname);
	});

	// ---- Continue here --------------------------------------------------------------------------

	async function adopt(workoutId: string, kind: Parameters<typeof workoutPath>[0]) {
		const href = resolve(workoutPath(kind));
		const outcome = await continueHereFlow(workoutId, href, { goto, flags: resumeState });
		if (outcome === 'gone') settle(NOTHING);
	}
</script>

{#snippet words()}
	<span class="text" data-danger={line.danger || undefined}
		>{line.before}{#if line.title !== null}<span data-testid="resume-title">{line.title}</span
			>{line.after}{/if}</span
	>
{/snippet}

{#snippet chevron()}
	<span class="chevron"><Icon name="chevron-right" size={14} /></span>
{/snippet}

<div class="resume-slot" data-looked={looked} data-testid="resume-slot">
	{#if resume.type !== 'none'}
		<div class="resume-bar" data-type={resume.type} data-testid="resume-bar">
			{#if resume.type === 'active'}
				{@const workout = resume.workout}
				{@const stopwatch =
					workout.stopwatch.startedAt === null
						? startStopwatch(Date.parse(workout.startedAt))
						: workout.stopwatch}
				<a class="main link" href={resolve(workoutPath(workout.kind))} data-testid="resume-link"
					>{@render words()}</a
				>
				<!-- Beside the link, not in it: the link's name holds all of its visible text. -->
				<Stopwatch {stopwatch} />
				<SyncPill {status} />
				{@render chevron()}
			{:else if resume.type === 'waiting'}
				<a
					class="main link"
					href={resolve('/(app)/progress/workouts/[[id]]', {})}
					data-testid="resume-link">{@render words()}</a
				>
				<SyncPill {status} />
				{@render chevron()}
			{:else}
				{@const workout = resume.workout}
				<div class="main" role="status">{@render words()}</div>
				<Button
					variant="ghost"
					size="sm"
					loading={resumeState.continuing}
					onclick={() => adopt(workout.id, workout.kind)}
					data-testid="continue-here">{resumeState.failed ? 'Try again' : 'Continue here'}</Button
				>
			{/if}
		</div>
	{/if}
</div>

<style>
	.resume-slot {
		display: contents;
	}

	/*
	 * The line's room, which is its height: 44 px and the 12 px below it (Paper's 24 px line with
	 * 32 below, widened to a touch target). The shell's --nav-inset-bottom grows by it (tokens.css),
	 * and the line sits in that growth, on the tab bar's hairline (from 1024 px, on the home
	 * indicator's room).
	 */
	:global(:root:has(.resume-bar)) {
		--resume-inset: calc(var(--touch-target) + var(--space-3));
	}

	.resume-bar {
		position: fixed;
		z-index: var(--z-sticky);
		bottom: calc(var(--nav-inset-bottom) - var(--resume-inset));
		left: calc(50% + var(--nav-inset-left) / 2);
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		gap: var(--space-3);
		/* As wide as the shell's column (<main>), so its words start with the screen's. */
		width: min(calc(100% - var(--nav-inset-left)), var(--content-column));
		height: var(--resume-inset);
		padding: 0 max(var(--gutter), var(--safe-right)) var(--space-3)
			max(var(--gutter), var(--safe-left));
		/* No fill in Paper; the canvas, as the tab bar's, so content scrolls under it unseen. */
		background: var(--color-canvas);
		animation: var(--duration-base) var(--ease-out) both rise;
	}

	/* It rises 4 px into place: below 1024 px from under the tab bar, which is drawn over it. */
	@keyframes rise {
		from {
			opacity: 0;
			transform: translate(-50%, var(--space-1));
		}
	}

	/*
	 * The words come first: never narrower than 120 px ("Resume" and the title's first letters,
	 * then an ellipsis), and all the room the time, the pill and the chevron leave. 120 px still
	 * fits a 320 px phone beside a four-digit time, where the pill gives way instead.
	 */
	.main {
		display: flex;
		flex: 1 0 7.5rem;
		align-items: center;
		min-width: 0;
		min-height: var(--touch-target);
		color: var(--color-text);
		text-decoration: none;
	}

	/* The whole row is the link: the time, the pill and the chevron too. */
	.link::after {
		content: '';
		position: absolute;
		inset: 0;
	}

	.text {
		flex: 1;
		min-width: 0;
		font: var(--type-row);
		line-height: 1.4118; /* 17/24, Paper */
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.text[data-danger] {
		color: var(--color-danger);
	}

	.chevron {
		display: flex;
		flex: none;
		color: var(--color-text-tertiary);
	}

	.resume-bar :global(.clock) {
		flex: none;
		font: var(--type-secondary);
		color: var(--color-text-secondary);
	}

	/*
	 * The pill is as wide as its words now, not as its longest words (SyncPill reserves those for
	 * the workout header, where nothing beside it gives way): here they would leave the line's own
	 * words no room. When even its words do not fit, it shrinks and clips, and the words keep theirs.
	 */
	.resume-bar :global(.sync) {
		flex: 0 1 auto;
		min-width: 0;
		margin-left: 0;
		overflow: hidden;
	}

	.resume-bar :global(.pill) {
		min-width: 0;
		justify-items: stretch;
	}

	.resume-bar :global(.pill)::before,
	.resume-bar :global(.pill)::after {
		content: none;
	}

	.resume-bar :global(.pill .words) {
		min-width: 0;
		overflow: hidden;
		white-space: nowrap;
	}

	@media (hover: hover) and (pointer: fine) {
		.link:hover .text {
			color: var(--color-text-secondary);
		}
	}

	.link:focus-visible {
		outline-offset: 2px;
		border-radius: var(--radius-sm);
	}
</style>
