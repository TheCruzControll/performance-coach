<!--
  @component
  The resume bar (resume.ts decides what it offers): loaded by the app shell on idle, never in the
  first render, and drawn only when there is something to offer. Screen chrome, fixed over the
  content column: above the tab bar below 1024 px, at the bottom of the column beside the rail
  from there. It raises --nav-inset-bottom by its own room (tokens.css, --resume-inset), so the
  shell's bottom padding and every other bottom chrome clear it and it covers nothing.
  - Resume workout · title · time, with the sync pill: a link to the kind's page.
  - N changes waiting to sync, with the pill: a link to History. While changes wait (here or in a
    workout in progress), the screen's sync engine runs, so they sync from any tab.
  - Continue here (Today only, online, nothing on this device): builds the other device's workout
    here, then opens its page.
  It looks again on every screen change, when the page becomes visible again, and once the
  engine has synced everything. data-looked names the screen it last looked for.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { workoutPath } from '#lib/client/workout/kinds.ts';
	import type { OutboxStatus } from '#lib/client/workout/outbox-rules.ts';
	import { outboxStatus } from '#lib/client/workout/status.svelte.ts';
	import { startStopwatch } from '#lib/domain/workout/timers.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import Stopwatch from '#lib/ui/workout/Stopwatch.svelte';
	import SyncPill from '#lib/ui/workout/SyncPill.svelte';
	import {
		continueHere,
		findResume,
		hasPending,
		NOTHING,
		REMOTE_CHECK_PATHS,
		syncFromHere,
		type Resume
	} from './resume.ts';

	let { pathname }: { pathname: string } = $props();

	let found = $state.raw<Resume>(NOTHING);
	/** The remote offer belongs to its screen: it never follows the owner to another tab. */
	const resume = $derived(
		found.type === 'remote' && !REMOTE_CHECK_PATHS.includes(pathname) ? NOTHING : found
	);

	/** The screen it last looked for, once it has: what the specs wait for. */
	let looked = $state<string | null>(null);
	async function look(path: string) {
		const next = await findResume(path);
		if (path !== pathname) return;
		found = next;
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

	let continuing = $state(false);
	let failed = $state(false);
	async function adopt(workoutId: string, kind: Parameters<typeof workoutPath>[0]) {
		if (continuing) return;
		continuing = true;
		failed = false;
		const outcome = await continueHere(workoutId);
		continuing = false;
		if (outcome === 'opened') await goto(resolve(workoutPath(kind)));
		else if (outcome === 'gone') found = NOTHING;
		else failed = true;
	}

	const plural = (n: number) => (n === 1 ? 'change' : 'changes');
</script>

<div class="resume-slot" data-looked={looked} data-testid="resume-slot">
	{#if resume.type !== 'none'}
		<div class="resume-bar" data-type={resume.type} data-testid="resume-bar">
			{#if resume.type === 'active'}
				{@const workout = resume.workout}
				{@const stopwatch =
					workout.stopwatch.startedAt === null
						? startStopwatch(Date.parse(workout.startedAt))
						: workout.stopwatch}
				<a
					class="main link"
					href={resolve(workoutPath(workout.kind))}
					aria-label={`Resume workout: ${workout.title}`}
					data-testid="resume-link"
				>
					<span class="lead"><Icon name="play" size={18} /></span>
					<span class="text">
						<strong>Resume workout</strong>
						<span class="detail" data-testid="resume-title">{workout.title}</span>
					</span>
					<Stopwatch {stopwatch} />
				</a>
				<SyncPill {status} />
			{:else if resume.type === 'waiting'}
				<a
					class="main link"
					href={resolve('/(app)/progress/workouts/[[id]]', {})}
					data-testid="resume-link"
				>
					<span class="lead"><Icon name="refresh" size={18} /></span>
					<span class="text">
						<strong>{resume.pending} {plural(resume.pending)} waiting to sync</strong>
						<span class="detail">History</span>
					</span>
				</a>
				<SyncPill {status} />
			{:else}
				{@const workout = resume.workout}
				<div class="main" role="status">
					<span class="lead"><Icon name="device" size={18} /></span>
					<span class="text">
						{#if failed}
							<strong>Couldn’t continue it here</strong>
							<span class="detail">Check your connection, then try again</span>
						{:else}
							<strong>In progress on another device</strong>
							<span class="detail" data-testid="resume-title">{workout.title}</span>
						{/if}
					</span>
				</div>
				<Button
					size="sm"
					icon="arrow-right"
					loading={continuing}
					onclick={() => adopt(workout.id, workout.kind)}
					data-testid="continue-here">{failed ? 'Try again' : 'Continue here'}</Button
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
	 * The bar's room: its height and the gap above the tab bar (or the window's bottom edge). The
	 * shell's --nav-inset-bottom grows by it (tokens.css), and the bar sits under that growth.
	 */
	:global(:root:has(.resume-bar)) {
		--resume-inset: calc(3.75rem + var(--space-2));
	}

	.resume-bar {
		position: fixed;
		z-index: var(--z-sticky);
		bottom: calc(var(--nav-inset-bottom) - var(--resume-inset) + var(--space-2));
		left: calc(50% + var(--nav-inset-left) / 2);
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		gap: var(--space-2);
		width: min(calc(100% - var(--nav-inset-left) - 2 * var(--gutter)), var(--content-column));
		height: 3.75rem;
		padding: 0 var(--space-3) 0 var(--space-1);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background: var(--color-surface-2);
		box-shadow: var(--elevation-2);
		animation: var(--duration-base) var(--ease-out) both rise;
	}

	@keyframes rise {
		from {
			opacity: 0;
			transform: translate(-50%, 0.5rem);
		}
	}

	.main {
		display: flex;
		flex: 1;
		align-items: center;
		gap: var(--space-3);
		min-width: 0;
		min-height: 2.75rem;
		padding: var(--space-1) var(--space-2);
		border-radius: var(--radius-md);
		color: var(--color-text);
		text-decoration: none;
	}

	.lead {
		display: grid;
		flex: none;
		place-items: center;
		width: 2.25rem;
		height: 2.25rem;
		border-radius: var(--radius-full);
		background: var(--color-accent);
		color: var(--color-on-accent);
	}

	[data-type='waiting'] .lead,
	[data-type='remote'] .lead {
		background: var(--color-surface-3);
		color: var(--color-text);
	}

	.text {
		display: grid;
		flex: 1;
		min-width: 0;
		line-height: var(--leading-tight);
	}

	.text strong {
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}

	.text > * {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.detail {
		font-size: var(--text-xs);
		color: var(--color-text-secondary);
	}

	.link :global(.clock) {
		flex: none;
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.resume-bar :global(.sync) {
		flex: none;
		margin-left: 0;
	}

	@media (hover: hover) and (pointer: fine) {
		.link:hover {
			background: var(--color-surface-3);
		}
	}

	.link:focus-visible {
		outline-offset: -2px;
	}
</style>
