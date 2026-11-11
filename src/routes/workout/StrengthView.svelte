<!--
  @component
  The strength workout (PRD §7): the current exercise (the device's position, so a reload returns
  to it) as an ExerciseCard with its set rows, and from 1024 px the session's exercise list beside
  it. Below 1024 px the current exercise has the screen. It renders two siblings, the side list
  and the main column, which the Shell lays out as its columns.
  - Under the rows, the logger (Logger.svelte, loaded once the first render has painted, and shown
    as soon as it has; a tap before the store is open waits for it) logs the set at hand in one
    tap: the row is done in the same frame, before anything is written, and in a superset the move
    to the partner is written with it. It never waits for the network. Below 1024 px its space is
    reserved from the first render at the height it last had on this device (logger-space.ts), so
    neither it nor the rest pill above it moves when it arrives.
  - A set this device could not save reads 'Not saved on this device'; the logger offers Retry.
  - A logged or skipped set is a button: it opens its editor (SetEditor.svelte), loaded on intent
    (the row's hover, focus or touch), whose Save sends a set.edit and whose Delete, confirmed, a
    set.delete. A chunk that cannot load (gone
    after a deploy) turns the page to 'App updated — reload to continue', never a broken sheet.
  - Under the card, its navigation (Navigation.svelte, loaded after the first paint and shown
    once the store can write, as the logger is, its space reserved meanwhile): Previous and Next,
    Up next (and Finish workout once every exercise is done), the swipe across the card and, from
    1024 px, the side list. Each is a goTo, stored with the workout, so a reload returns to it.
  - The rest timer (RestTimer.svelte), while the workout holds a rest: a completed set starts it
    (log.ts, through workout-flow). Below 1024 px it is a pill in the thumb zone just above the
    logger, stuck there on every exercise, so it stays in view while browsing; from 1024 px it
    docks at the top of the main column, under the header, over nothing. It is first in the DOM,
    so the keyboard reaches it first on a desktop. Its controls are device actions; Skip and
    Dismiss clear it. With no rest, once the exercise has a set done, Start rest in its place
    starts the exercise's (flow.ts restAt): for a device that leaves the rest to the owner, or
    another after Skip. A tap on its controls before the store is open waits for it, with the time
    of the tap. At zero (feedback.ts, loaded after the first paint): a vibration and a tone
    as the device's settings allow; the screen is kept awake during rest when they ask for it.
  - The card's Options button opens the exercise's quick actions (ExerciseActionsSheet.svelte,
    loaded on intent): Machine unavailable, Suggest an alternative, I don't like this exercise,
    This hurts and Skip exercise. The card then says what became of the slot, and a substitute never shows
    the planned exercise's load.
  - A set of an exercise loaded with a bar or plates has a plate button: it opens the plate
    calculator (PlateSheet.svelte, loaded on the button's first touch) at the set's weight, done
    or planned, in its unit, with this device's bar and plates.
  - A substitute's or an added exercise's last session is not in the kit: when such a slot is
    current, its previous sets are fetched and attached to the workout (previous.ts, loaded
    then, or with the picker); offline, the card says 'No previous sets on this device'.
  - Add exercise, in Up next and after the side list's last exercise, opens the picker
    (ExercisePicker.svelte, loaded on intent) over the library cached on this device. A session
    with no exercise yet (an ad-hoc strength one) says so, with Add exercise in the card's place.
  - The card's exercise name opens its history (ExerciseHistorySheet.svelte, loaded on intent);
    offline, it shows the previous session this device holds and says so.
  - Each render keeps the card's words on the device (prepaint.ts), so the next load paints the
    current exercise before the app starts (Prepaint.svelte).
-->
<script lang="ts">
	import type {
		ActiveSnapshot,
		ActiveWorkout,
		ChunkLoad
	} from '#lib/client/workout/active.svelte.ts';
	import type * as Feedback from '#lib/client/workout/feedback.ts';
	import { clearPrepaint, prepaintCard, writePrepaint } from '#lib/client/workout/prepaint.ts';
	import { readWorkoutSettings } from '#lib/client/workout/settings.ts';
	import { SLOT_STATE_COPY } from '#lib/domain/workout/copy.ts';
	import { groups } from '#lib/domain/workout/groups.ts';
	import type { SlotView } from '#lib/domain/workout/index.ts';
	import { REST_STEP_MS, restDone, restRemaining } from '#lib/domain/workout/timers.ts';
	import type { CanonicalSet } from '#lib/domain/workout/protocol.ts';
	import { currentExercise, plannedVsLogged, previousFor } from '#lib/domain/workout/selectors.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import ExerciseCard from '#lib/ui/workout/ExerciseCard.svelte';
	import RestTimer from '#lib/ui/workout/RestTimer.svelte';
	import SetRow from '#lib/ui/workout/SetRow.svelte';
	import {
		doneText,
		lastTimeText,
		loadLine,
		restText,
		SET_STATE_WORDS,
		setRows
	} from '#lib/ui/workout/set-words.ts';
	import { onMount, tick, untrack, type ComponentProps } from 'svelte';
	import type { HistoryRequest } from '#lib/client/workout/exercise-history.ts';
	import type ExerciseHistorySheet from '#lib/ui/workout/ExerciseHistorySheet.svelte';
	import type ExerciseActionsSheet from './ExerciseActionsSheet.svelte';
	import type ExercisePicker from './ExercisePicker.svelte';
	import ExerciseList from './ExerciseList.svelte';
	import { afterPaint } from './lazy.ts';
	import { keepLoggerSpace, readLoggerSpace } from './logger-space.ts';
	import type LoggerView from './Logger.svelte';
	import type NavigationView from './Navigation.svelte';
	import type PlateSheet from './PlateSheet.svelte';
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
		const loadType = view.exercises[slot.exerciseId]?.loadType;
		const name = nameOf(slot.exerciseId);
		// Each row with the set it shows, to edit: none for a set not logged, or not saved here.
		// A barbell or plate-loaded exercise's rows open the plate calculator at their weight.
		const rows = setRows(paired, slot.state === 'skipped' || slot.state === 'stopped').map(
			(row, i) => {
				const { logged: set, planned } = paired[i]!;
				const prescribed = planned?.prescribedWeight;
				const plates = loadType === 'external' && {
					target: set?.weight ?? prescribed?.value,
					unit:
						(set?.weight == null ? prescribed?.unit : set.unit) ?? view.kit?.units.weight ?? 'kg',
					label: `Set ${row.setIndex} · ${name}`
				};
				return set && notSaved.has(set.id)
					? { ...row, plates, state: 'not-saved' as const, word: SET_STATE_WORDS['not-saved'] }
					: { ...row, plates, set };
			}
		);
		const sets = slot.kit?.sets ?? [];
		// The set at hand: the current row's, else (all done) the first.
		const at = sets[(rows.find((row) => row.state === 'current')?.setIndex ?? 1) - 1];
		const previous = previousFor(view, slot.position);
		const loadOf = (set: (typeof sets)[number] | undefined) =>
			loadLine(set && (planned ? set : { ...set, prescribedWeight: null }), loadType);
		const stateText = SLOT_STATE_COPY[slot.state];
		const lookup =
			view.device.attached[slot.exerciseId] === undefined ? lookups[slot.exerciseId] : undefined;
		return {
			position: slot.position,
			name,
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

	// The card this device keeps for the next load to paint before the app starts (prepaint.ts),
	// written again from each render: the store drops it on every change. Only a workout in
	// progress with every change written here (none pending): any other would not be there after
	// a reload.
	$effect(() => {
		if (current && snapshot.pending === 0 && view.workout.status === 'in_progress') {
			const rest = view.device.rest !== null;
			writePrepaint({ workoutId: view.workout.id, rest, card: prepaintCard(current) });
		} else {
			clearPrepaint();
		}
	});

	// The logger and its prefill rules load once the first render has painted (Logger.svelte says
	// why), so their requests never delay the card's; it shows as soon as it has, its space kept
	// meanwhile (the height it last had here). The navigation loads with it.
	let Logger = $state.raw<typeof LoggerView | null>(null);
	const reserved = import.meta.env.SSR ? null : readLoggerSpace();
	let Navigation = $state.raw<typeof NavigationView | null>(null);
	onMount(() => {
		if (import.meta.env.SSR) return;
		afterPaint(() => {
			void load(() => import('./Logger.svelte')).then((module) => {
				if (module) Logger = module.default;
			});
			void load(() => import('./Navigation.svelte')).then((module) => {
				if (module) Navigation = module.default;
			});
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

	// Add exercise: the picker, fetched on a button's first intent, opened afresh on each tap. The
	// exercise picked is current at once and asks for its last session (lookUp), so previous.ts
	// comes with the picker: a session with no lookup yet (an empty one) adds offline too.
	let Picker = $state.raw<typeof ExercisePicker | null>(null);
	let picking = $state.raw<object | null>(null);
	function prefetchPicker() {
		void load(() => import('./ExercisePicker.svelte')).then((module) => {
			if (module) Picker = module.default;
		});
		void load(() => import('#lib/client/workout/previous.ts'));
	}
	function openPicker(event: MouseEvent) {
		(event.currentTarget as HTMLElement).focus();
		prefetchPicker();
		picking = {};
	}

	// The exercise's history: fetched on the name's first intent, opened on each tap.
	let History = $state.raw<typeof ExerciseHistorySheet | null>(null);
	let viewing = $state.raw<HistoryRequest | null>(null);
	function prefetchHistory() {
		void load(() => import('#lib/ui/workout/ExerciseHistorySheet.svelte')).then((module) => {
			if (module) History = module.default;
		});
	}
	function openHistory(slot: SlotView, event: MouseEvent) {
		(event.currentTarget as HTMLElement).focus();
		prefetchHistory();
		const fallback = previousFor(view, slot.position);
		viewing = { exerciseId: slot.exerciseId, name: nameOf(slot.exerciseId), fallback };
	}

	/** The card's area, which a swipe crosses. */
	let area = $state<HTMLElement>();

	// ---- The rest timer ---------------------------------------------------------------------

	const rest = $derived(view.device.rest);

	/**
	 * Start rest: the exercise's rest, with the device's defaults read now. The flow comes with
	 * the logger's chunk, already loaded by then, so the first render does not carry it; one that
	 * is gone after a deploy turns the page to 'App updated' (load).
	 */
	async function startRest(position: number) {
		const at = Date.now();
		const flow = await load(() => import('#lib/domain/workout/flow.ts'));
		if (!flow) return;
		const durationMs = flow.restAt(view, position, readWorkoutSettings().rest);
		active.store?.dispatch({ type: 'rest.start', workoutId: view.workout.id, at, durationMs });
	}

	/** A rest action at the time of the tap: now, or as the store opens (right after the first paint). */
	function restAction(
		type: 'rest.pause' | 'rest.resume' | 'rest.reset' | 'rest.add' | 'rest.clear'
	) {
		const workoutId = view.workout.id;
		const at = Date.now();
		if (type !== 'rest.clear') {
			active.write((store) =>
				store.dispatch(
					type === 'rest.add' ? { type, workoutId, at, ms: REST_STEP_MS } : { type, workoutId, at }
				)
			);
			return;
		}
		// The timer goes with the button a keyboard focused: the focus moves on to logging, or the page.
		const focused = document.activeElement;
		const keyboard =
			focused?.closest('[data-testid="rest-timer"]') && focused.matches(':focus-visible');
		active.write((store) => {
			store.dispatch({ type, workoutId });
			if (!keyboard) return;
			void tick().then(() => {
				const next = document.querySelector<HTMLElement>('[data-testid="complete-set"]');
				(next ?? document.getElementById('main'))?.focus();
			});
		});
	}

	let feedback = $state.raw<{
		vibrate: typeof Feedback.vibrate;
		tone: Feedback.Tone;
		wakeLock: Feedback.ScreenWakeLock;
	} | null>(null);

	onMount(() => {
		if (import.meta.env.SSR) return;
		let gone = false;
		// The tone listens for the page's first tap, which browsers ask before it may sound. After
		// the first paint, as the logger.
		afterPaint(
			() =>
				void import('#lib/client/workout/feedback.ts')
					.then((module) => {
						if (gone) return;
						const { vibrate, createTone, createWakeLock } = module;
						feedback = { vibrate, tone: createTone(), wakeLock: createWakeLock() };
					})
					// Feedback is a nicety: the timer on screen is what tells the rest is over.
					.catch(() => {})
		);
		return () => {
			gone = true;
			feedback?.tone.dispose();
			void feedback?.wakeLock.release();
		};
	});

	// Awake during rest when the settings ask; at zero, the vibration and the tone they allow. Only
	// a rest that ends while the page is open: one that ended while it was closed says so on screen.
	$effect(() => {
		const current = rest;
		const fx = feedback;
		if (!fx) return;
		const now = Date.now();
		const resting = current !== null && !restDone(current, now);
		if (resting && readWorkoutSettings().keepAwake) void fx.wakeLock.acquire();
		else void fx.wakeLock.release();
		if (!resting || current.pausedAt !== null) return;
		const timer = setTimeout(
			() => {
				const settings = readWorkoutSettings();
				if (settings.vibration) fx.vibrate();
				if (settings.sound) fx.tone.play();
				void fx.wakeLock.release();
			},
			restRemaining(current, now)
		);
		return () => clearTimeout(timer);
	});

	/** The main column, and the sticky logger's height there, which the pill sits above. */
	let main = $state<HTMLElement>();
	let loggerHeight = $state(0);
	let pillHeight = $state(0);
	/** Start rest shows with no rest once the exercise has a set done to rest from. */
	const startable = $derived(
		active.store !== null && !!current?.slot.sets.some((set) => !set.isSkipped)
	);

	// The logger (or its reserved space) comes and goes (all sets logged, Add a set) and grows
	// (Missed reps): followed, for the pill and for the next load's reserved space.
	$effect(() => {
		if (!main) return;
		const column = main;
		let logger: HTMLElement | null = null;
		const sizes = new ResizeObserver(() => (loggerHeight = logger?.offsetHeight ?? 0));
		const find = () => {
			const found = column.querySelector<HTMLElement>(
				':scope > [data-testid="set-logger"], :scope > .logger-space'
			);
			if (found === logger) return;
			if (logger) sizes.unobserve(logger);
			logger = found;
			if (!found) {
				loggerHeight = 0;
				return;
			}
			sizes.observe(found);
			// Measured now, not at the observer's first report a frame later: the pill that appears
			// with the first rest, or a new logger, never shows at the foot before it moves above it.
			loggerHeight = found.offsetHeight;
		};
		const children = new MutationObserver(find);
		children.observe(column, { childList: true });
		find();
		return () => {
			children.disconnect();
			sizes.disconnect();
		};
	});

	// Only a logger stuck to the foot (below 1024 px, SetLogger's CSS): from there it sits in the
	// column, under the rows, and none is kept.
	$effect(() => {
		const logger = loggerHeight > 0 && main?.querySelector(':scope > [data-testid="set-logger"]');
		if (logger && getComputedStyle(logger).position === 'sticky') keepLoggerSpace(loggerHeight);
	});

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

	// The plate calculator: fetched on a plate button's first touch, opened afresh on each tap.
	let Plates = $state.raw<typeof PlateSheet | null>(null);
	let weighing = $state.raw<ComponentProps<typeof PlateSheet>['request'] | null>(null);
	function prefetchPlates() {
		void load(() => import('./PlateSheet.svelte')).then((module) => {
			if (module) Plates = module.default;
		});
	}

	function weigh(request: NonNullable<typeof weighing>, event: MouseEvent) {
		(event.currentTarget as HTMLElement).focus();
		prefetchPlates();
		weighing = { ...request };
	}

	function edit(set: CanonicalSet, event: MouseEvent) {
		// Safari never focuses a tapped button: the sheet returns focus to what has it.
		(event.currentTarget as HTMLElement).focus();
		prefetch();
		editing = { set };
	}
</script>

<ExerciseList {items} current={current?.position} onadd={openPicker} onintent={prefetchPicker} />

<div class="main" data-testid="workout-main" bind:this={main}>
	{#if rest}
		<div class="rest" style:--logger-height="{loggerHeight}px" style:--pill-height="{pillHeight}px">
			<div class="pill" bind:offsetHeight={pillHeight}>
				<RestTimer
					{rest}
					onpause={() => restAction('rest.pause')}
					onresume={() => restAction('rest.resume')}
					onreset={() => restAction('rest.reset')}
					onadd={() => restAction('rest.add')}
					onclear={() => restAction('rest.clear')}
				/>
			</div>
		</div>
	{:else if current && startable}
		{@const position = current.position}
		<div
			class="rest start"
			style:--logger-height="{loggerHeight}px"
			style:--pill-height="{pillHeight}px"
		>
			<div class="pill" bind:offsetHeight={pillHeight}>
				<Button
					variant="secondary"
					icon="play"
					data-testid="start-rest"
					onclick={() => void startRest(position)}>Start rest</Button
				>
			</div>
		</div>
	{/if}
	{#if view.slots.length === 0}
		<EmptyState
			icon="plate"
			tone="strength"
			title="No exercises yet"
			description="Add one from your exercise list. It's saved on this device as you log, even offline."
			data-testid="workout-no-exercises"
		>
			{#snippet actions()}
				<Button
					icon="plus"
					onpointerdown={prefetchPicker}
					onclick={openPicker}
					data-testid="add-first-exercise">Add exercise</Button
				>
			{/snippet}
		</EmptyState>
	{/if}
	{#if current}
		<div class="swipe" bind:this={area}>
			<ExerciseCard
				exercise={current}
				status={current.status}
				noPrevious={current.noPrevious}
				onhistory={(event) => openHistory(current.slot, event)}
				onhistoryintent={prefetchHistory}
			>
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
					{@const plates = row.plates}
					<SetRow
						{row}
						onedit={set ? (event) => edit(set, event) : undefined}
						onintent={prefetch}
						onplates={plates ? (event) => weigh(plates, event) : undefined}
						onplatesintent={prefetchPlates}
					/>
				{/each}
			</ExerciseCard>
		</div>
		<div class="navigation">
			{#if Navigation && area && active.store}
				<Navigation
					{view}
					{area}
					store={active.store}
					onfinish={() => (active.finishing = true)}
					onadd={openPicker}
					onintent={prefetchPicker}
				/>
			{/if}
		</div>
	{/if}
	{#if current && Logger}
		<Logger
			{view}
			slot={current.slot}
			open={current.open}
			notSaved={snapshot.notSaved}
			write={active.write}
		/>
	{:else if current && reserved !== null}
		<div
			class="logger-space"
			style:height="{reserved}px"
			aria-hidden="true"
			data-testid="logger-space"
		></div>
	{/if}
	{#if Editor && editing && active.store}
		<Editor {view} {editing} store={active.store} />
	{/if}
	{#if Plates && weighing}
		<Plates request={weighing} />
	{/if}
	{#if Actions && acting && active.store}
		<Actions
			{view}
			request={acting}
			store={active.store}
			{load}
			onfinish={() => (active.finishing = true)}
		/>
	{/if}
	{#if Picker && picking && active.store}
		<Picker {view} request={picking} store={active.store} {load} />
	{/if}
	{#if History && viewing}<History request={viewing} />{/if}
</div>

<style>
	.main {
		display: flex;
		flex: 1;
		flex-direction: column;
		gap: var(--space-4);
		min-width: 0;
	}

	/* Start rest, with no rest: a quiet control at the timer's place, at the end of the row. */
	.start .pill {
		display: flex;
		justify-content: flex-end;
	}

	/* The logger's place while it loads, below 1024 px: SetLogger's box, stuck to the foot, empty. */
	.logger-space {
		display: none;
	}

	/* Vertical drags scroll the page; sideways ones are the swipe's, so it never scrolls sideways. */
	.swipe {
		touch-action: pan-y;
		-webkit-user-select: none;
		user-select: none;
	}

	/* Previous and Next, then Up next with its Add exercise: their height is kept while they load.
	   Packed at the top, so a shorter Up next never moves Previous and Next. */
	.navigation {
		display: grid;
		align-content: start;
		gap: var(--space-4);
		min-height: 13rem;
	}

	/*
	 * Below 1024 px the rest pill follows the card and its navigation (it is first in the DOM for
	 * the desktop's order), at the foot, and stays in view while the page scrolls: stuck above the
	 * home indicator, or, with a logger, fixed just above it. Not sticky there: a sticky pill
	 * cannot rise above the column's top, so a tall logger on a short screen pushed it under
	 * itself. Its place in the flow keeps its height, so it never covers the end of the page.
	 */
	@media (width < 64rem) {
		.swipe,
		.navigation {
			order: -1;
		}

		.rest {
			position: sticky;
			bottom: calc(var(--safe-bottom) + var(--space-4));
			z-index: var(--z-sticky);
			margin-top: auto;
		}

		.logger-space {
			display: block;
			position: sticky;
			bottom: 0;
			z-index: var(--z-sticky);
			margin: auto calc(-1 * max(var(--gutter), var(--safe-right)))
				calc(-1 * (var(--space-8) + var(--safe-bottom)))
				calc(-1 * max(var(--gutter), var(--safe-left)));
			border-top: 1px solid var(--color-border);
			background: var(--color-surface-1);
			box-shadow: var(--elevation-2);
		}

		.main:has(> :global([data-testid='set-logger']), > .logger-space) > .rest {
			position: static;
			height: var(--pill-height);
		}

		.main:has(> :global([data-testid='set-logger']), > .logger-space) > .rest > .pill {
			position: fixed;
			inset-inline: max(var(--gutter), var(--safe-left)) max(var(--gutter), var(--safe-right));
			bottom: calc(max(var(--logger-height), var(--safe-bottom)) + var(--space-4));
			z-index: var(--z-sticky);
			max-width: calc(var(--content-column) - 2 * var(--gutter));
			margin-inline: auto;
		}

		/* Start rest's row lets taps beside the button through. */
		.start {
			pointer-events: none;
		}

		.start .pill > :global(*) {
			pointer-events: auto;
		}

		/* The pill takes the logger's place at the foot, so the logger follows it directly. */
		.main:has(> .rest) > :global([data-testid='set-logger']),
		.main:has(> .rest) > .logger-space {
			margin-top: 0;
		}
	}
</style>
