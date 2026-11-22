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
  - Ask the coach, as in the exercise sheet.
  Everything works offline, and each change is one dispatch, written on the device first.
-->
<script lang="ts">
	import type { ChunkLoad } from '#lib/client/workout/active.svelte.ts';
	import type { WorkoutStore } from '#lib/client/workout/store.ts';
	import { SESSION_ACTION_COPY } from '#lib/domain/workout/copy.ts';
	import type { WorkoutView } from '#lib/domain/workout/index.ts';
	import type { PainChoice } from '#lib/domain/workout/substitution.ts';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import { ASK_QUESTIONS, askHref } from '#lib/ui/ask-link.ts';
	import type { PainDetails } from './actions.ts';
	import type PainSheet from './PainSheet.svelte';
	import { sessionPain } from './session-actions.ts';

	interface Props {
		view: WorkoutView;
		/** A new object per tap: each opens the sheet afresh. */
		request: object;
		store: WorkoutStore;
		/** The page's chunk loader, for the pain sheet. */
		load: ChunkLoad;
		/** Skip's segment (run-log.ts nextToLog); null hides Skip, and is always null for a class. */
		skipTo: number | null;
		/** Opens Finish, after End the workout here. */
		onfinish: () => void;
	}

	let { view, request, store, load, skipTo, onfinish }: Props = $props();

	let open = $state(false);
	$effect.pre(() => {
		void request;
		open = true;
	});

	const title = $derived(SESSION_ACTION_COPY.title[view.workout.kind === 'run' ? 'run' : 'other']);

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
</script>

<BottomSheet bind:open {title} description={view.workout.title} data-testid="session-actions-sheet">
	<div class="body">
		<ul class="menu">
			<li>
				<button type="button" class="entry" onclick={hurts} data-testid="session-action-pain">
					<span class="label">{SESSION_ACTION_COPY.pain.label}</span>
					<span class="detail">{SESSION_ACTION_COPY.pain.detail}</span>
				</button>
			</li>
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
