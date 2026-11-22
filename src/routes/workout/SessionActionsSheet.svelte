<!--
  @component
  A run's or a class's quick actions (PRD §6; session-actions.ts), in a BottomSheet (a centred
  dialog from 1024 px), code-split and loaded on the Options button's first intent. Each tap opens
  it afresh at its menu:
  - This hurts opens the pain sheet over it (PainSheet.svelte, loaded then) in its session form.
    Its one choice, End the workout here, sends the report (sessionPain) and opens Finish
    (`onfinish`).
  - Skip this segment, in a run with another segment still to log, moves to it (`skipTo`).
    Nothing is recorded.
  - Swap, where a lighter choice exists (`swapOptions`), opens its options in this sheet, Back
    returning to the menu. In a run, Swap to a zone 2 bike ends the run where it is (its finish,
    or its abandon when nothing was run) and starts the bike session in its place, then opens
    /workout/session. In a class, a lighter type goes to the class view (`onlighter`), which
    sets its type field; nothing is sent until Save.
  - Ask the coach, as in the exercise sheet.
  Everything works offline, and each change is one dispatch, written on the device first.
-->
<script lang="ts">
	import type { ChunkLoad } from '#lib/client/workout/active.svelte.ts';
	import { WORKOUT_PATHS } from '#lib/client/workout/kinds.ts';
	import type { WorkoutStore, WriteOutcome } from '#lib/client/workout/store.ts';
	import {
		OTHER_SESSION_KIND_LABEL,
		type OtherSessionKind
	} from '#lib/domain/training/vocabulary.ts';
	import { SESSION_ACTION_COPY } from '#lib/domain/workout/copy.ts';
	import type { WorkoutView } from '#lib/domain/workout/index.ts';
	import type { PainChoice } from '#lib/domain/workout/substitution.ts';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import { ASK_QUESTIONS, askHref } from '#lib/ui/ask-link.ts';
	import type { PainDetails } from './actions.ts';
	import type PainSheet from './PainSheet.svelte';
	import {
		bikeStart,
		runEnd,
		sessionPain,
		swapOptions,
		type SwapChoice
	} from './session-actions.ts';

	interface Props {
		view: WorkoutView;
		/** A new object per tap: each opens the sheet afresh. */
		request: object;
		store: WorkoutStore;
		/** The page's chunk loader, for the pain sheet. */
		load: ChunkLoad;
		/** Skip's segment (run-log.ts nextToLog); null hides Skip, and is always null for a class. */
		skipTo: number | null;
		/** A run's planned minutes still to run (run-log.ts minutesToRun); null when unknown or in a class. */
		minutesLeft: number | null;
		/** A class's type as its fields show it; null in a run. */
		sessionKind: OtherSessionKind | null;
		/** A lighter class type picked: the class view sets its type field. */
		onlighter: (kind: OtherSessionKind) => void;
		/** Opens Finish, after End the workout here. */
		onfinish: () => void;
	}

	let { view, request, store, load, skipTo, minutesLeft, sessionKind, onlighter, onfinish }: Props =
		$props();

	let open = $state(false);
	let swapping = $state(false);
	$effect.pre(() => {
		void request;
		open = true;
		swapping = false;
	});

	const title = $derived(SESSION_ACTION_COPY.title[view.workout.kind === 'run' ? 'run' : 'other']);
	const swapWords = $derived(
		SESSION_ACTION_COPY.swap[view.workout.kind === 'run' ? 'run' : 'other']
	);
	const options = $derived(swapOptions(view, sessionKind, minutesLeft));
	const choiceLabel = (choice: SwapChoice) =>
		choice.to === 'bike'
			? `${SESSION_ACTION_COPY.swap.bike} · ${choice.minutes} min`
			: OTHER_SESSION_KIND_LABEL[choice.kind];

	let Pain = $state.raw<typeof PainSheet | null>(null);
	let hurting = $state(false);

	function hurts() {
		void load(() => import('./PainSheet.svelte')).then((module) => {
			if (module) [Pain, hurting] = [module.default, true];
		});
	}

	function skip() {
		if (skipTo !== null)
			store.dispatch({ type: 'goTo', workoutId: view.workout.id, position: skipTo });
		open = false;
	}

	function report(_choice: PainChoice, details: PainDetails) {
		store.dispatch(sessionPain(view, details, new Date().toISOString()));
		open = false;
		onfinish();
	}

	/**
	 * Swap to the bike: the run ends and the bike starts, both dispatched before either is awaited
	 * (the first ends the run in memory, so the second may start); then the page moves to the
	 * class route, which shows the bike. Another tab's workout refuses the start: the run is still
	 * ended, and the page shows it completed.
	 */
	async function swapToBike(minutes: number) {
		const before = view;
		const kit = before.kit;
		open = false;
		if (kit?.kind !== 'run') return;
		const at = Date.now();
		const ended = store.dispatch(...runEnd(before, at)).saved;
		let started: Promise<WriteOutcome>;
		try {
			started = store.dispatch(...bikeStart(before, kit, minutes, at)).saved;
		} catch {
			return;
		}
		if ((await ended) === 'saved' && (await started) === 'saved')
			location.replace(WORKOUT_PATHS.other);
	}

	function swapTo(choice: SwapChoice) {
		if (choice.to === 'bike') return void swapToBike(choice.minutes);
		onlighter(choice.kind);
		open = false;
	}
</script>

<BottomSheet bind:open {title} description={view.workout.title} data-testid="session-actions-sheet">
	{#if swapping}
		<div class="body" data-testid="session-swap">
			<p class="detail">{swapWords.note}</p>
			<ul class="menu">
				{#each options as choice (choice.to === 'bike' ? 'bike' : choice.kind)}
					<li>
						<button
							type="button"
							class="entry"
							onclick={() => swapTo(choice)}
							data-testid="session-swap-option"
						>
							<span class="label">{choiceLabel(choice)}</span>
						</button>
					</li>
				{/each}
			</ul>
			<Button variant="secondary" onclick={() => (swapping = false)}>
				{SESSION_ACTION_COPY.swap.back}
			</Button>
		</div>
	{:else}
		<div class="body">
			<ul class="menu">
				<li>
					<button type="button" class="entry" onclick={hurts} data-testid="session-action-pain">
						<span class="label">{SESSION_ACTION_COPY.pain.label}</span>
						<span class="detail">{SESSION_ACTION_COPY.pain.detail}</span>
					</button>
				</li>
				{#if options.length > 0}
					<li>
						<button
							type="button"
							class="entry"
							onclick={() => (swapping = true)}
							data-testid="session-action-swap"
						>
							<span class="label">{swapWords.label}</span>
							<span class="detail">{swapWords.detail}</span>
						</button>
					</li>
				{/if}
				{#if skipTo !== null}
					<li>
						<button type="button" class="entry" onclick={skip} data-testid="session-action-skip">
							<span class="label">{SESSION_ACTION_COPY.skip.label}</span>
							<span class="detail">{SESSION_ACTION_COPY.skip.detail}</span>
						</button>
					</li>
				{/if}
			</ul>
			<ListRow
				icon="coach"
				title="Ask the coach"
				subtitle={ASK_QUESTIONS.workout}
				href={askHref(ASK_QUESTIONS.workout, 'workout', { type: 'workout', id: view.workout.id })}
				data-testid="ask-coach"
			/>
		</div>
	{/if}
</BottomSheet>

{#if Pain}
	<Pain bind:open={hurting} {view} onreport={report} />
{/if}

<style>
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.body,
	.menu {
		display: grid;
		gap: var(--space-2);
	}

	.body {
		gap: var(--space-4);
	}

	.entry {
		display: grid;
		gap: var(--space-0-5);
		width: 100%;
		min-height: 56px;
		padding: var(--space-3);
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		background: var(--color-surface-2);
		color: var(--color-text);
		font: inherit;
		text-align: start;
		cursor: pointer;
		transition:
			border-color var(--duration-fast) var(--ease-standard),
			background-color var(--duration-fast) var(--ease-standard);
	}

	.entry:active {
		background: var(--color-surface-3);
	}

	.entry:focus-visible {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	@media (hover: hover) and (pointer: fine) {
		.entry:hover {
			border-color: var(--color-border-strong);
			background: var(--color-surface-3);
		}
	}

	.label {
		font-weight: var(--weight-semibold);
	}

	.detail {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}
</style>
