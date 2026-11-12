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
  - Once the first render (data-ready, which waits for the view and stopwatch chunks too, not
    only the restore) has painted, on every engine (afterPaint: WebKit has no idle callback), the
    store loads (its write path stays out of the first render) with the page's one sync engine
    (online.ts), which every change the store reports flushes, from any view or sheet; unmounting
    stops it. A tap that comes first waits for it (ActiveWorkout.write). RUM loads on idle, so
    INP is attributed to the workout route. data-store and performance.mark('pc:store-open',
    once per page) mark the store open; the view gets the active workout, to write through it.
    A workout the start flow began from a saved kit (kit-mark.ts) then has its fresh kit fetched
    in the background (kit-refresh.ts, loaded then). A fresh kit for an edited plan (replanned)
    shows 'Your plan changed' while nothing is done in the workout: Use the new plan discards it
    and starts the session again from the fresh kit.
  - The sync status loads after the engine (sync-ui.ts): the header's pill, which opens the
    sync sheet. After a 401 the page shows the signed-out state instead of the workout: no workout
    details, only the changes waiting. A page restored after a 401 (active.signedOut) shows none
    of it before the engine has said otherwise.
  - Finish and Discard: the header's More button opens the workout menu (WorkoutMenu.svelte, loaded
    with the store), and Finish (from it, the header's visible Finish once a set is logged,
    HeaderFinish.svelte, which loads with it, or the strength view's after the last exercise)
    the finish sheet (FinishSheet.svelte, loaded then). Done sends the finish through the store
    (finish.ts); online, once the server has it, the sheet opens its History detail. Otherwise
    the page shows its completed state (Summary.svelte, loaded then): the summary, read-only,
    from IndexedDB and the precache, so an offline reload keeps it, with 'View in History' once
    the workout has synced.
  - Nothing reads the URL while prerendering: the HTML is the same, data-free, for everyone.
  - prepaint: the page's current exercise, painted before the app starts from what this device
    kept (Prepaint.svelte, /workout's), in the skeleton's place while restoring; from 1024 px it
    takes the view's columns, so the view replaces it in place. Any phase but a workout in progress
    drops what the device kept (prepaint.ts).
  - start: /workout?start= or ?new=, which the page reads once mounted. The start flow's chunk
    (StartFlow.svelte) is shown instead of any workout, through the page's chunk loader; the
    page neither connects its own store nor sends a workout of another kind to its route.
  - Layout: one column below 1024 px; from there the header spans the page, and the view's side
    and main columns sit side by side, centred, at --content-list beside --content-readable.
-->
<script module lang="ts">
	// The header's stopwatch, which the first paint waits for: asked as the module is evaluated,
	// before the page hydrates, as the routes ask for their views. Handled when the Shell mounts.
	const clock = import.meta.env.SSR ? null : import('./WorkoutClock.svelte');
	clock?.catch(() => {});
</script>

<script lang="ts">
	import { onMount, untrack, type Component, type Snippet } from 'svelte';
	import {
		ActiveWorkout,
		type ActiveSnapshot,
		type ChunkLoad
	} from '#lib/client/workout/active.svelte.ts';
	import { workoutPath } from '#lib/client/workout/kinds.ts';
	import { kitRefreshMarked } from '#lib/client/workout/kit-mark.ts';
	import type * as KitRefresh from '#lib/client/workout/kit-refresh.ts';
	import type { AnyTable } from '#lib/domain/workout/project.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import Skeleton from '#lib/ui/components/Skeleton.svelte';
	import EmptyWorkout from './EmptyWorkout.svelte';
	import type FinishSheet from './FinishSheet.svelte';
	import type HeaderFinishComponent from './HeaderFinish.svelte';
	import type Summary from './Summary.svelte';
	import { afterPaint, chunkLoader } from './lazy.ts';
	import type * as SyncUi from './sync-ui.ts';
	import type WorkoutClock from './WorkoutClock.svelte';
	import WorkoutHeader from './WorkoutHeader.svelte';
	import type WorkoutMenu from './WorkoutMenu.svelte';

	interface Props {
		/** Loads the route's reducer table (reducers/tables.ts): it decides the kind this page shows. */
		table: () => Promise<AnyTable>;
		/** The view: its side column (if any), then its main column, as siblings. */
		children: Snippet<[ActiveSnapshot, ChunkLoad, ActiveWorkout]>;
		/** A lazy view's chunk: the restoring skeleton stays until it has loaded. */
		ready?: () => Promise<unknown>;
		/** The start flow's chunk, once the page has read ?start or ?new. */
		start?: () => Promise<{ default: Component<{ load: ChunkLoad }> }>;
		/** The current exercise painted before the app starts, shown while restoring. */
		prepaint?: Snippet;
	}

	let { table, children, ready, start, prepaint }: Props = $props();

	// A route's table never changes: read once.
	const active = new ActiveWorkout(untrack(() => table));
	const load = chunkLoader(() => active.stale());
	const restore = $derived(active.current);
	const view = $derived('snapshot' in restore ? restore.snapshot.view : null);
	let Completed = $state.raw<typeof Summary | null>(null);
	let viewLoaded = $state(!untrack(() => ready));
	let Clock = $state.raw<typeof WorkoutClock | null>(null);
	const viewReady = $derived(viewLoaded && Clock !== null);
	const waiting = $derived(
		restore.phase === 'loading' ||
			restore.phase === 'elsewhere' ||
			(restore.phase === 'active' && !viewReady) ||
			(restore.phase === 'completed' && !Completed)
	);
	let ui = $state.raw<typeof SyncUi | null>(null);
	let Menu = $state.raw<typeof WorkoutMenu | null>(null);
	/** The header's visible Finish, which loads with the menu. */
	let HeaderFinish = $state.raw<typeof HeaderFinishComponent | null>(null);
	let Finish = $state.raw<typeof FinishSheet | null>(null);
	const sync = $derived(ui?.outboxStatus.current);
	const signedOut = $derived(sync?.state === 'signed-out' ? sync.waiting : null);
	const hidden = $derived(signedOut !== null || (active.signedOut && !sync));
	let Start = $state.raw<Component<{ load: ChunkLoad }> | null>(null);
	const starting = $derived(!!start && restore.phase !== 'app-updated');
	/** What the page may show of the workout: nothing once signed out, or while starting one. */
	const shown = $derived(hidden || start ? null : view);
	/** kit-refresh.ts once the fresh kit pins an edited plan's session (replanned). */
	let replanned = $state.raw<typeof KitRefresh | null>(null);
	const offerFresh = $derived(!!replanned && !!shown && replanned.untouched(shown));

	const idle = (run: () => void) => {
		if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 2000 });
		else setTimeout(run, 500);
	};

	onMount(() => {
		if (ready) void load(ready).then((module) => (viewLoaded = module !== null));
		void load(() => clock!).then((module) => {
			if (module) Clock = module.default;
		});
		void active.restore(load);
		return () => active.close();
	});

	let connecting = false;
	$effect(() => {
		if (waiting || connecting) return;
		connecting = true;
		// RUM once the page shows what it restored, never before: its chunks would compete with
		// the view's. Its observers are buffered, so it still reports the load's paints.
		idle(() => {
			void import('#lib/client/vitals.ts')
				.then((rum) => rum.startVitalsReporting())
				.catch(() => {});
		});
		afterPaint(async () => {
			if (start) return;
			const opened = await active.connect(load);
			// Once per page, as pc:logger-ready (Logger.svelte): the first load's figure.
			if (opened && performance.getEntriesByName('pc:store-open', 'mark').length === 0)
				performance.mark('pc:store-open');
			const shownId = 'snapshot' in active.current ? active.current.snapshot.workoutId : null;
			if (opened && shownId && kitRefreshMarked(shownId)) {
				void load(() => import('#lib/client/workout/kit-refresh.ts'))
					.then(async (module) => {
						if ((await module?.refreshMarked(opened, shownId)) === 'replanned') replanned = module;
					})
					.catch(() => {});
			}
			ui = await load(() => import('./sync-ui.ts'));
			const menu = await load(() => import('./WorkoutMenu.svelte'));
			Menu = menu?.default ?? null;
			HeaderFinish = menu?.HeaderFinish ?? null;
		});
	});

	// The finish sheet once Finish is asked for; the summary once the workout is finished.
	$effect(() => {
		if (active.finishing)
			void load(() => import('./FinishSheet.svelte')).then((m) => m && (Finish = m.default));
	});
	$effect(() => {
		if (restore.phase === 'completed')
			void load(() => import('./Summary.svelte')).then((m) => m && (Completed = m.default));
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

	// No workout in progress here (none, finished, another kind's, or no storage): the next load
	// paints the skeleton, not a card this device kept. Loaded then, so no workout page's first
	// render carries it.
	$effect(() => {
		if (restore.phase === 'loading' || restore.phase === 'active') return;
		void import('#lib/client/workout/prepaint.ts')
			.then((module) => module.clearPrepaint())
			.catch(() => {});
	});

	const reload = () => location.reload();

	async function startAfresh() {
		const id = 'snapshot' in restore ? restore.snapshot.workoutId : null;
		const url = id && active.store ? await replanned?.startAfresh(active.store, id) : null;
		if (url) location.replace(url);
		else replanned = null;
	}
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
			{#if shown && Clock && restore.phase === 'active'}<Clock
					view={shown}
					write={active.write}
					{load}
				/>{/if}
		{/snippet}
		{#snippet status()}
			{#if ui && active.store}
				<ui.SyncStatus store={active.store} view={shown} {load} />
			{/if}
		{/snippet}
		{#snippet menu()}
			{#if shown && restore.phase === 'active'}
				<span class="menu">
					{#if Menu && active.store}
						<Menu view={shown} store={active.store} onfinish={() => (active.finishing = true)} />
					{/if}
				</span>
			{/if}
		{/snippet}
		{#snippet finish()}
			{#if shown && restore.phase === 'active' && HeaderFinish && active.store}
				<HeaderFinish view={shown} onfinish={() => (active.finishing = true)} />
			{/if}
		{/snippet}
	</WorkoutHeader>

	<div class="body">
		{#if starting && Start}
			<Start {load} />
		{:else if ui && signedOut !== null}
			<ui.SignedOutState waiting={signedOut} />
		{:else if restore.phase === 'active' && viewReady && !hidden && !starting}
			{#if offerFresh}
				<div class="replanned">
					<Notice icon="refresh" title="Your plan changed" data-testid="workout-replanned">
						This session was edited after this device saved it.
						<Button size="sm" variant="secondary" onclick={startAfresh}>Use the new plan</Button>
					</Notice>
				</div>
			{/if}
			<div class="columns">{@render children(restore.snapshot, load, active)}</div>
		{:else if restore.phase === 'completed' && Completed && !hidden && !starting}
			{@const { view: done, notSaved } = restore.snapshot}
			<div class="columns">
				<Completed view={done} completed={{ status: sync, notSaved, store: active.store }} />
			</div>
		{:else if waiting || hidden || starting}
			<div class="restoring" role="status" aria-busy="true" data-testid="workout-restoring">
				<span class="visually-hidden">Restoring your workout</span>
				{@render prepaint?.()}
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
	{#if Finish && shown}
		<Finish bind:open={active.finishing} view={shown} store={active.store} />
	{/if}
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

	.replanned {
		margin-bottom: var(--space-4);
	}

	.restoring {
		display: grid;
		gap: var(--space-4);
	}

	/* The More button's place, kept while it loads: the title's line height, so the header never
	   moves; the 44 px button overhangs it. */
	.menu {
		display: flex;
		align-items: center;
		justify-content: center;
		min-width: var(--touch-target);
		height: 2.5rem;
		margin-right: calc(-1 * var(--space-2));
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

		.replanned {
			margin-bottom: var(--space-4);
		}

		.restoring {
			max-width: var(--content-readable);
			margin: 0 auto;
		}

		/* A prepainted card takes the view's columns (Prepaint.svelte). */
		.restoring:has(> :global(.prepaint:not([hidden], [data-rest]))) {
			max-width: none;
		}
	}
</style>
