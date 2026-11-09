<!--
  @component
  The workout pages' shell, shared by the three prerendered workout routes (/workout,
  /workout/run, /workout/session). Outside (app): no tab bar or rail, so the thumb zone belongs to
  logging, and no shell applies the safe areas, so it does (header: --safe-top; content:
  --safe-left and --safe-right; foot: --safe-bottom).
  - It renders <main id='main'>, the root layout's skip-link target (prerendering needs it).
  - It restores the workout from IndexedDB alone (active.svelte.ts), loading the projection, the
    route's reducer table and the header's stopwatch (WorkoutClock.svelte) meanwhile: a skeleton
    that reserves the header, then the view, 'No workout in progress', 'This browser can't keep a workout' or 'App
    updated — reload to continue'. A workout of another kind is sent to its own route first.
  - On idle after the first render (data-ready, which waits for the view and stopwatch chunks
    too, not only the restore), the store loads (its write path stays out of the first render) with the
    page's one sync engine (online.ts), which every change the store reports flushes, from any
    view or sheet; unmounting stops it. RUM loads on idle too, so INP is attributed to the
    workout route. data-store marks the store open; the view gets the active workout, to write
    through it.
  - The sync status loads on idle after the engine (sync-ui.ts): the header's pill, which opens the
    sync sheet. After a 401 the page shows the signed-out state instead of the workout: no workout
    details, only the changes waiting. A page restored after a 401 (active.signedOut) shows none
    of it before the engine has said otherwise.
  - Nothing reads the URL while prerendering: the HTML is the same, data-free, for everyone.
  - start: /workout?start= or ?new=, which the page reads once mounted. The start flow's chunk
    (StartFlow.svelte) is shown instead of any workout, through the page's chunk loader; the
    page neither connects its own store nor sends a workout of another kind to its route.
  - Layout: one column below 1024 px; from there the header spans the page, and the view's side
    and main columns sit side by side, centred, at --content-list beside --content-readable.
-->
<script lang="ts">
	import { onMount, untrack, type Component, type Snippet } from 'svelte';
	import {
		ActiveWorkout,
		type ActiveSnapshot,
		type ChunkLoad
	} from '#lib/client/workout/active.svelte.ts';
	import { workoutPath } from '#lib/client/workout/kinds.ts';
	import type { AnyTable } from '#lib/domain/workout/project.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import Skeleton from '#lib/ui/components/Skeleton.svelte';
	import EmptyWorkout from './EmptyWorkout.svelte';
	import { chunkLoader } from './lazy.ts';
	import type * as SyncUi from './sync-ui.ts';
	import type WorkoutClock from './WorkoutClock.svelte';
	import WorkoutHeader from './WorkoutHeader.svelte';

	interface Props {
		/** Loads the route's reducer table (reducers/tables.ts): it decides the kind this page shows. */
		table: () => Promise<AnyTable>;
		/** The view: its side column (if any), then its main column, as siblings. */
		children: Snippet<[ActiveSnapshot, ChunkLoad, ActiveWorkout]>;
		/** A lazy view's chunk: the restoring skeleton stays until it has loaded. */
		ready?: () => Promise<unknown>;
		/** The start flow's chunk, once the page has read ?start or ?new. */
		start?: () => Promise<{ default: Component<{ load: ChunkLoad }> }>;
	}

	let { table, children, ready, start }: Props = $props();

	// A route's table never changes: read once.
	const active = new ActiveWorkout(untrack(() => table));
	const load = chunkLoader(() => active.stale());
	const restore = $derived(active.current);
	const view = $derived(restore.phase === 'active' ? restore.snapshot.view : null);
	let viewLoaded = $state(!untrack(() => ready));
	let Clock = $state.raw<typeof WorkoutClock | null>(null);
	const viewReady = $derived(viewLoaded && Clock !== null);
	const waiting = $derived(
		restore.phase === 'loading' ||
			restore.phase === 'elsewhere' ||
			(restore.phase === 'active' && !viewReady)
	);
	let ui = $state.raw<typeof SyncUi | null>(null);
	const sync = $derived(ui?.outboxStatus.current);
	const signedOut = $derived(sync?.state === 'signed-out' ? sync.waiting : null);
	const hidden = $derived(signedOut !== null || (active.signedOut && !sync));
	let Start = $state.raw<Component<{ load: ChunkLoad }> | null>(null);
	const starting = $derived(!!start && restore.phase !== 'app-updated');
	/** What the page may show of the workout: nothing once signed out, or while starting one. */
	const shown = $derived(hidden || start ? null : view);

	const idle = (run: () => void) => {
		if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 2000 });
		else setTimeout(run, 500);
	};

	onMount(() => {
		if (ready) void load(ready).then((module) => (viewLoaded = module !== null));
		void load(() => import('./WorkoutClock.svelte')).then((module) => {
			if (module) Clock = module.default;
		});
		void active.restore(load);
		idle(
			() =>
				void import('#lib/client/vitals.ts')
					.then((rum) => rum.startVitalsReporting())
					.catch(() => {})
		);
		return () => active.close();
	});

	let connecting = false;
	$effect(() => {
		if (waiting || connecting) return;
		connecting = true;
		idle(async () => {
			if (start) return;
			await active.connect(load);
			ui = await load(() => import('./sync-ui.ts'));
		});
	});

	// The start flow, once the page asks for it; a chunk that is gone shows 'App updated'.
	$effect(() => {
		if (start) void load(start).then((module) => module && (Start = module.default));
	});

	// Another kind's workout: its own route, before any view renders, keeping this page's query.
	// A full navigation to a prerendered page (from the precache offline); goto() would reject a
	// route this build does not have yet (/workout/run and /workout/session land later). Never
	// while starting: the start flow answers a workout in progress itself.
	$effect(() => {
		if (start || restore.phase !== 'elsewhere') return;
		location.replace(`${workoutPath(restore.kind)}${location.search}`);
	});

	const reload = () => location.reload();
</script>

<main
	id="main"
	class="workout"
	tabindex="-1"
	data-phase={restore.phase}
	data-ready={waiting ? undefined : ''}
	data-store={active.store ? '' : undefined}
>
	<WorkoutHeader title={waiting ? null : (shown?.workout.title ?? 'Workout')}>
		{#snippet time()}
			{#if shown && Clock}<Clock view={shown} store={active.store} />{/if}
		{/snippet}
		{#snippet status()}
			{#if ui && active.store}
				<ui.SyncStatus store={active.store} view={shown} {load} />
			{/if}
		{/snippet}
	</WorkoutHeader>

	<div class="body">
		{#if starting && Start}
			<Start {load} />
		{:else if ui && signedOut !== null}
			<ui.SignedOutState waiting={signedOut} />
		{:else if restore.phase === 'active' && viewReady && !hidden && !starting}
			<div class="columns">{@render children(restore.snapshot, load, active)}</div>
		{:else if waiting || hidden || starting}
			<div class="restoring" role="status" aria-busy="true" data-testid="workout-restoring">
				<span class="visually-hidden">Restoring your workout</span>
				{#each [0, 1, 2] as card (card)}
					<Skeleton height="10rem" radius="var(--radius-lg)" />
				{/each}
			</div>
		{:else if restore.phase === 'empty'}
			<EmptyWorkout />
		{:else if restore.phase === 'no-storage'}
			<EmptyState
				icon="database"
				tone="neutral"
				title="This browser can't keep a workout"
				description="A workout is saved on this device as you log it, and this browser won't let the app save anything. Private browsing is the usual cause: open the app in a normal window, or from your Home Screen, then try again."
				data-testid="workout-no-storage"
			>
				{#snippet actions()}
					<Button variant="secondary" icon="refresh" onclick={reload}>Try again</Button>
				{/snippet}
			</EmptyState>
		{:else}
			<EmptyState
				icon="refresh"
				title="App updated — reload to continue"
				description="A newer version of the app is running on this device. Everything you logged is saved here, so reloading picks up exactly where you left off."
				data-testid="workout-app-updated"
			>
				{#snippet actions()}
					<Button icon="refresh" onclick={reload}>Reload</Button>
				{/snippet}
			</EmptyState>
		{/if}
	</div>

	<div class="foot" data-testid="workout-foot"></div>
</main>

<style>
	.workout {
		/* The two columns from 1024 px: the side list beside a readable column. */
		--workout-width: calc(var(--content-list) + var(--space-8) + var(--content-readable));
		display: grid;
		grid-template-rows: auto 1fr auto;
		min-height: 100dvh;
		outline: none;
	}

	/* Below 1024 px the view's main column fills the screen, so its logger reaches the foot. */
	.body {
		display: flex;
		flex-direction: column;
		width: 100%;
		max-width: var(--content-column);
		margin: 0 auto;
		padding: var(--space-2) max(var(--gutter), var(--safe-right)) var(--space-8)
			max(var(--gutter), var(--safe-left));
	}

	.columns {
		display: flex;
		flex: 1;
		flex-direction: column;
	}

	.restoring {
		display: grid;
		gap: var(--space-4);
	}

	/* Reserved for the fixed bottom controls (the logger, the rest pill) and the home indicator. */
	.foot {
		padding-bottom: var(--safe-bottom);
	}

	@media (width >= 64rem) {
		.body {
			max-width: calc(var(--workout-width) + 2 * var(--gutter));
			padding-top: var(--space-6);
		}

		.columns {
			display: grid;
			grid-template-columns: var(--content-list) minmax(0, var(--content-readable));
			justify-content: center;
			align-items: start;
			gap: var(--space-8);
		}

		/* A view without a side column keeps the readable column, centred. */
		.columns > :global(:only-child) {
			grid-column: 1 / -1;
			justify-self: center;
			width: min(100%, var(--content-readable));
		}

		.restoring {
			max-width: var(--content-readable);
			margin: 0 auto;
		}
	}
</style>
