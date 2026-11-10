<!--
  @component
  An exercise's quick actions (PRD §8; substitution.ts says what each one means), in a
  BottomSheet (a centred dialog from 1024 px), code-split and loaded on the card's Options
  button's first intent. Each tap opens it afresh at its list:
  - Machine unavailable and Suggest an alternative open the kit's alternatives (AlternativeList,
    ranked for the reason); choosing one swaps the exercise for this session only.
  - I don't like this exercise opens them too, then asks first: Cancel changes nothing, and only
    the confirmation sends the dislike, which also stops it being prescribed.
  - This hurts opens the pain sheet over it (PainSheet.svelte, loaded then): the choice made there
    is sent with its pain report (actions.ts reportPain); End the workout here then opens Finish
    (`onfinish`).
  - Skip exercise skips its remaining sets and moves on.
  Everything comes from the start kit, so it all works offline. When nothing fits, the list says
  why and offers Skip exercise. Each change is one dispatch, written on the device first.
-->
<script lang="ts">
	import type { ChunkLoad } from '#lib/client/workout/active.svelte.ts';
	import type { WorkoutStore } from '#lib/client/workout/store.ts';
	import {
		ALTERNATIVES_COPY,
		dislikeConfirmation,
		QUICK_ACTION_COPY
	} from '#lib/domain/workout/copy.ts';
	import type { KitAlternative, WorkoutView } from '#lib/domain/workout/index.ts';
	import { slotAt } from '#lib/domain/workout/selectors.ts';
	import { effectsOf } from '#lib/domain/workout/substitution.ts';
	import type { PainChoice } from '#lib/domain/workout/substitution.ts';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import { tick } from 'svelte';
	import { alternativesFor, dislike, reportPain, skipExercise, substitute } from './actions.ts';
	import type { PainDetails, SwapAction } from './actions.ts';
	import AlternativeList from './AlternativeList.svelte';
	import type PainSheet from './PainSheet.svelte';

	interface Props {
		view: WorkoutView;
		/** The tapped card's slot, a new object per tap: each opens the sheet afresh. */
		request: { position: number };
		store: WorkoutStore;
		/** The page's chunk loader, for the pain sheet. */
		load: ChunkLoad;
		/** Opens Finish, after End the workout here. */
		onfinish: () => void;
	}

	let { view, request, store, load, onfinish }: Props = $props();

	type Step =
		| { kind: 'menu' }
		| { kind: 'alternatives'; action: SwapAction }
		| { kind: 'confirm'; replacement: KitAlternative };

	let open = $state(false);
	let step = $state.raw<Step>({ kind: 'menu' });
	let body: HTMLDivElement | undefined = $state();
	$effect.pre(() => {
		void request;
		step = { kind: 'menu' };
		open = true;
	});

	const position = $derived(request.position);
	const slot = $derived(slotAt(view, position));
	const name = $derived((slot && view.exercises[slot.exerciseId]?.name) ?? 'Exercise');
	const MENU = ['machine_unavailable', 'suggest_alternative', 'dislike', 'pain', 'skip'] as const;

	/** Moves to a step, focus on its first control. */
	async function go(next: Step) {
		step = next;
		await tick();
		body?.querySelector<HTMLElement>('button')?.focus();
	}

	function send(...actions: Parameters<WorkoutStore['dispatch']>) {
		store.dispatch(...actions);
		open = false;
	}

	const now = () => new Date().toISOString();

	let Pain = $state.raw<typeof PainSheet | null>(null);
	let hurting = $state(false);

	function choose(action: (typeof MENU)[number]) {
		if (action === 'pain') {
			return void load(() => import('./PainSheet.svelte')).then((module) => {
				if (module) [Pain, hurting] = [module.default, true];
			});
		}
		if (action !== 'skip') return void go({ kind: 'alternatives', action });
		const { mutation, followUps } = skipExercise(view, position, now());
		send(mutation, ...followUps);
	}

	function pick(action: SwapAction, alternative: KitAlternative) {
		const to = alternative.exercise.id;
		if (action === 'dislike') return void go({ kind: 'confirm', replacement: alternative });
		send(substitute(view, position, to, action, now()));
	}

	function report(choice: PainChoice, details: PainDetails) {
		const { mutations, followUps } = reportPain(view, position, choice, details, now());
		const [first, ...rest] = mutations;
		if (first) send(first, ...rest, ...followUps);
		if (choice.action === 'ended_workout') onfinish();
	}

	const confirmation = $derived(
		step.kind === 'confirm' && slot
			? dislikeConfirmation(
					{ exercise: name, replacement: step.replacement.exercise.name },
					effectsOf('dislike', slot).changesProgram
				)
			: null
	);
	const title = $derived(
		step.kind === 'alternatives'
			? ALTERNATIVES_COPY[step.action].title
			: (confirmation?.title ?? 'Exercise options')
	);
	const description = $derived(
		step.kind === 'alternatives' ? ALTERNATIVES_COPY[step.action].note : name
	);
</script>

<BottomSheet bind:open {title} {description} data-testid="exercise-actions-sheet">
	<div class="body" bind:this={body}>
		{#if step.kind === 'menu'}
			<ul class="menu">
				{#each MENU as action (action)}
					<li>
						<button
							type="button"
							class="entry"
							onclick={() => choose(action)}
							data-testid={`action-${action}`}
						>
							<span class="label">{QUICK_ACTION_COPY[action].label}</span>
							<span class="detail">{QUICK_ACTION_COPY[action].detail}</span>
						</button>
					</li>
				{/each}
			</ul>
		{:else if step.kind === 'alternatives' && slot}
			{@const action = step.action}
			<AlternativeList
				alternatives={alternativesFor(slot, action)}
				blocked={slot.kit?.blocked ?? []}
				onchoose={(alternative) => pick(action, alternative)}
				onskip={() => choose('skip')}
			/>
			<Button variant="ghost" icon="chevron-left" onclick={() => go({ kind: 'menu' })}>Back</Button>
		{:else if step.kind === 'confirm' && confirmation}
			{@const to = step.replacement.exercise.id}
			<p class="confirm" data-testid="dislike-confirmation">{confirmation.body}</p>
			<div class="actions">
				<Button variant="secondary" onclick={() => (open = false)} data-testid="dislike-cancel">
					{confirmation.cancel}
				</Button>
				<Button
					onclick={() => send(dislike(view, position, to, now()))}
					data-testid="dislike-confirm"
				>
					{confirmation.confirm}
				</Button>
			</div>
		{/if}
	</div>
</BottomSheet>

{#if Pain}
	<Pain bind:open={hurting} {view} {position} onreport={report} />
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

	.confirm {
		line-height: var(--leading-normal);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: var(--space-2);
	}
</style>
