<!--
  @component
  The strength workout (PRD §7): the current exercise (the device's position, so a reload returns
  to it) as an ExerciseCard with its set rows, and from 1024 px the session's exercise list beside
  it. Below 1024 px the current exercise has the screen. It renders two siblings, the side list
  and the main column, which the Shell lays out as its columns.
  - Under the rows, the logger (Logger.svelte, loaded right after the first render, and shown
    once the store has loaded too, so Complete set never waits for either) logs the set at hand
    in one tap: the row is done in the same frame, before anything is written, and in a superset
    the move to the partner is written with it. It never waits for the network.
  - A set this device could not save reads 'Not saved on this device'; the logger offers Retry.
  - A logged or skipped set is a button: it opens its editor (SetEditor.svelte), loaded on intent
    (the row's hover, focus or touch), whose Save sends a set.edit and whose Delete, confirmed, a
    set.delete. A chunk that cannot load (gone
    after a deploy) turns the page to 'App updated — reload to continue', never a broken sheet.
  - Under the card, its navigation (Navigation.svelte, loaded after the first render and shown
    once the store can write, as the logger is, its space reserved meanwhile): Previous and Next,
    Up next, the swipe across the card and, from 1024 px, the side list. Each is a goTo, stored with the workout, so a reload returns to it.
  - The card's Options button opens the exercise's quick actions (ExerciseActionsSheet.svelte,
    loaded on intent): Machine unavailable, Suggest an alternative, I don't like this exercise
    and Skip exercise. The card then says what became of the slot, and a substitute never shows
    the planned exercise's load.
  - A substitute's or an added exercise's last session is not in the kit: when such a slot is
    current, its previous sets are fetched and attached to the workout (previous.ts, loaded
    then); offline, the card says 'No previous sets on this device'.
-->
<script lang="ts">
	import type {
		ActiveSnapshot,
		ActiveWorkout,
		ChunkLoad
	} from '#lib/client/workout/active.svelte.ts';
	import { SLOT_STATE_COPY } from '#lib/domain/workout/copy.ts';
	import { groups } from '#lib/domain/workout/groups.ts';
	import type { SlotView } from '#lib/domain/workout/index.ts';
	import type { CanonicalSet } from '#lib/domain/workout/protocol.ts';
	import { currentExercise, plannedVsLogged, previousFor } from '#lib/domain/workout/selectors.ts';
	import ExerciseCard from '#lib/ui/workout/ExerciseCard.svelte';
	import SetRow from '#lib/ui/workout/SetRow.svelte';
	import {
		doneText,
		lastTimeText,
		loadLine,
		restText,
		SET_STATE_WORDS,
		setRows
	} from '#lib/ui/workout/set-words.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import { onMount, untrack } from 'svelte';
	import type ExerciseActionsSheet from './ExerciseActionsSheet.svelte';
	import ExerciseList from './ExerciseList.svelte';
	import type LoggerView from './Logger.svelte';
	import type NavigationView from './Navigation.svelte';
	import type SetEditor from './SetEditor.svelte';

	interface Props {
		snapshot: ActiveSnapshot;
		/** The page's chunk loader, for the logger. */
		load: ChunkLoad;
		active: ActiveWorkout;
	}

	let { snapshot, load, active }: Props = $props();
	const view = $derived(snapshot.view);
	/** The rows this device could not save, by client id. */
	const notSaved = $derived(
		new Set(
			snapshot.notSaved.flatMap((n) =>
				n.entities.filter((key) => key.startsWith('set:')).map((key) => key.slice(4))
			)
		)
	);

	const labels = $derived(
		new Map(
			groups({ exercises: view.slots }).flatMap((group) =>
				group.members.map((member) => [member.position, member.label] as const)
			)
		)
	);

	// The projection names every exercise a slot performs, the kit's and the canonical rows'.
	const nameOf = (exerciseId: string) => view.exercises[exerciseId]?.name ?? 'Exercise';

	// Each exercise's planned sets and how many are logged or skipped (extra sets never count).
	const items = $derived(
		view.slots.map((slot) => {
			const total = slot.kit?.sets.length || slot.sets.length;
			return {
				position: slot.position,
				label: labels.get(slot.position),
				name: nameOf(slot.exerciseId),
				done: Math.min(total, slot.sets.filter((set) => !set.isExtra).length),
				total
			};
		})
	);

	// Last time for a substitute or an added exercise (previous.ts): being fetched, or unavailable.
	let lookups = $state<Record<string, 'pending' | 'unavailable'>>({});

	const current = $derived.by(() => {
		const slot = currentExercise(view);
		if (!slot) return null;
		// A substitute never shows the planned exercise's load: its own comes from its own sets.
		const planned = slot.kit?.exercise.id === slot.exerciseId;
		const paired = plannedVsLogged(view, slot.position).map((pair) =>
			planned || !pair.planned
				? pair
				: { ...pair, planned: { ...pair.planned, prescribedWeight: null } }
		);
		// Each row with the set it shows, to edit: none for a set not logged, or not saved here.
		const rows = setRows(paired, slot.state === 'skipped' || slot.state === 'stopped').map(
			(row, i) => {
				const set = paired[i]!.logged;
				return set && notSaved.has(set.id)
					? { ...row, state: 'not-saved' as const, word: SET_STATE_WORDS['not-saved'] }
					: { ...row, set };
			}
		);
		const sets = slot.kit?.sets ?? [];
		// The set at hand: the current row's, else (all done) the first.
		const at = sets[(rows.find((row) => row.state === 'current')?.setIndex ?? 1) - 1];
		const previous = previousFor(view, slot.position);
		const loadType = view.exercises[slot.exerciseId]?.loadType;
		const loadOf = (set: (typeof sets)[number] | undefined) =>
			loadLine(set && (planned ? set : { ...set, prescribedWeight: null }), loadType);
		const stateText = SLOT_STATE_COPY[slot.state];
		const lookup =
			view.device.attached[slot.exerciseId] === undefined ? lookups[slot.exerciseId] : undefined;
		return {
			position: slot.position,
			name: nameOf(slot.exerciseId),
			label: labels.get(slot.position),
			place: `Exercise ${view.slots.indexOf(slot) + 1} of ${view.slots.length}`,
			lines: [...new Set(sets.map((set) => set.line))],
			load: loadOf(at),
			rest: restText(at?.restSeconds),
			loads: sets.map(loadOf),
			rests: sets.map((set) => restText(set.restSeconds)),
			previous: previous && {
				heading: lastTimeText(previous.date, view.kit?.date),
				sets: previous.sets.map(doneText)
			},
			status: stateText
				? { text: stateText, instead: slot.kit && !planned ? slot.kit.exercise.name : null }
				: null,
			noPrevious:
				lookup === 'unavailable'
					? 'No previous sets on this device'
					: lookup === 'pending'
						? 'Last time · checking'
						: undefined,
			ended: slot.state === 'skipped' || slot.state === 'stopped',
			slot,
			open: rows.some((row) => row.state === 'current'),
			rows
		};
	});

	// The logger and its prefill rules load after the first render (Logger.svelte says why); it
	// shows once the store (the Shell's, on idle) can write too. The navigation loads with it.
	let Logger = $state.raw<typeof LoggerView | null>(null);
	let Navigation = $state.raw<typeof NavigationView | null>(null);
	onMount(() => {
		if (import.meta.env.SSR) return;
		void load(() => import('./Logger.svelte')).then((module) => {
			if (module) Logger = module.default;
		});
		void load(() => import('./Navigation.svelte')).then((module) => {
			if (module) Navigation = module.default;
		});
	});

	// Asked again each time a slot (or the exercise it performs) becomes current, never per set.
	const lookupKey = $derived(current && `${current.position}:${current.slot.exerciseId}`);
	$effect(() => {
		const store = active.store;
		if (lookupKey && store) untrack(() => void lookUp(store, current!.slot));
	});

	async function lookUp(store: NonNullable<typeof active.store>, slot: SlotView) {
		const id = slot.exerciseId;
		const asking = () => lookups[id] === 'pending';
		if (asking()) return;
		const module = await load(() => import('#lib/client/workout/previous.ts'));
		// Asked again meanwhile, and that ask got here first.
		if (!module || !module.needsPrevious(view, slot) || asking()) return;
		lookups[id] = 'pending';
		const found = await module.attachPrevious(store, view, slot).catch(() => 'unavailable');
		if (found === 'attached') delete lookups[id];
		else lookups[id] = 'unavailable';
	}

	// The quick actions: fetched on the Options button's first intent, opened on each tap.
	let Actions = $state.raw<typeof ExerciseActionsSheet | null>(null);
	let acting = $state.raw<{ position: number } | null>(null);
	function prefetchActions() {
		void load(() => import('./ExerciseActionsSheet.svelte')).then((module) => {
			if (module) Actions = module.default;
		});
	}
	function openActions(position: number, event: MouseEvent) {
		(event.currentTarget as HTMLElement).focus();
		prefetchActions();
		acting = { position };
	}

	/** The card's area, which a swipe crosses. */
	let area = $state<HTMLElement>();

	// The set editor: fetched on a row's first intent; a chunk that is gone shows 'App updated'.
	let Editor = $state.raw<typeof SetEditor | null>(null);
	// Asked on each intent: the browser fetches and runs a module once.
	function prefetch() {
		void load(() => import('./SetEditor.svelte')).then((module) => {
			if (module) Editor = module.default;
		});
	}

	/** The set being edited, as it was when its row was tapped (it may go while the sheet closes). */
	// A new object per tap, so tapping the same set again opens it again.
	let editing = $state.raw<{ set: CanonicalSet } | null>(null);

	function edit(set: CanonicalSet, event: MouseEvent) {
		// Safari never focuses a tapped button: the sheet returns focus to what has it.
		(event.currentTarget as HTMLElement).focus();
		prefetch();
		editing = { set };
	}
</script>

<ExerciseList {items} current={current?.position} />

<div class="main" data-testid="workout-main">
	{#if current}
		<div class="swipe" bind:this={area}>
			<ExerciseCard exercise={current} status={current.status} noPrevious={current.noPrevious}>
				{#snippet actions()}
					{#if !current.ended}
						<Button
							variant="secondary"
							icon="refresh"
							onpointerdown={prefetchActions}
							onclick={(event) => openActions(current.position, event)}
							aria-label="Exercise options"
							data-testid="exercise-actions">Options</Button
						>
					{/if}
				{/snippet}
				{#each current.rows as row, i (i)}
					{@const set = 'set' in row && row.set}
					<SetRow
						{row}
						onedit={set ? (event) => edit(set, event) : undefined}
						onintent={prefetch}
					/>
				{/each}
			</ExerciseCard>
		</div>
		<div class="navigation">
			{#if Navigation && area && active.store}<Navigation {view} {area} store={active.store} />{/if}
		</div>
	{/if}
	{#if current && Logger && active.store}
		<Logger
			{view}
			slot={current.slot}
			open={current.open}
			notSaved={snapshot.notSaved}
			store={active.store}
		/>
	{/if}
	{#if Editor && editing && active.store}
		<Editor {view} {editing} store={active.store} />
	{/if}
	{#if Actions && acting && active.store}
		<Actions {view} request={acting} store={active.store} />
	{/if}
</div>

<style>
	.main {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: var(--space-4);
		min-width: 0;
	}

	/* Vertical drags scroll the page; sideways ones are the swipe's, so it never scrolls sideways. */
	.swipe {
		touch-action: pan-y;
		-webkit-user-select: none;
		user-select: none;
	}

	/* Previous and Next, then Up next: their height is kept while they load. Packed at the top, so
	   a shorter Up next never moves Previous and Next. */
	.navigation {
		display: grid;
		align-content: start;
		gap: var(--space-4);
		min-height: 9.5rem;
	}
</style>
