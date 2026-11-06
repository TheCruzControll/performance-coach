<!--
  @component
  Profile → Goals (PRD §2): the goals in priority order, #1 marked "Top priority" because it wins
  when goals compete for time or recovery, or a designed empty state. A goal saves the moment it
  changes, through the route's `?/saveGoal` action, so the screen has no Save bar. The sheet that
  adds or edits a goal is code-split: it starts loading on first intent (pointerdown), and a tap
  that lands before it arrives still opens it.
-->
<script lang="ts">
	import { DISCIPLINE_INFO } from '#lib/domain/profile/catalog.ts';
	import type { Goal } from '#lib/domain/profile/types.ts';
	import Badge from '../components/Badge.svelte';
	import Button from '../components/Button.svelte';
	import Chip from '../components/Chip.svelte';
	import EmptyState from '../components/EmptyState.svelte';
	import Icon from '../components/Icon.svelte';
	import ListRow from '../components/ListRow.svelte';
	import Notice from '../components/Notice.svelte';
	import { toast } from '../toast.svelte';
	import type { EditorProps } from './editors';
	import { goalDraft, goalSummary, newGoal, type GoalDraft } from './goals';
	import type GoalSheet from './GoalSheet.svelte';

	let { value = $bindable() }: EditorProps<Goal[]> = $props();
	const id = $props.id();

	/** Open goals, top priority first (achieved and dropped goals hold no rank). */
	const ranked = $derived(
		value.filter((g) => g.priority !== null).sort((a, b) => a.priority! - b.priority!)
	);

	let Sheet = $state<typeof GoalSheet | null>(null);
	let loading: Promise<unknown> | null = null;
	let unavailable = $state(false);
	let open = $state(false);
	let draft = $state.raw<GoalDraft | null>(null);

	/** Fetch the sheet on first intent, so it is usually here by the time the tap lands. */
	function preload() {
		loading ??= import('./GoalSheet.svelte').then(
			(module) => (Sheet = module.default),
			() => (unavailable = true)
		);
	}

	function edit(next: GoalDraft) {
		preload();
		draft = next;
		open = true;
	}

	function saved(goals: Goal[]) {
		value = goals;
		open = false;
		toast.show('Goal saved', { tone: 'positive' });
	}
</script>

<div class="goals" data-testid="goals-editor">
	{#if ranked.length === 0}
		<EmptyState
			icon="target"
			title="What are you training for?"
			description="Add a goal and the coach plans your training around it."
			compact
			data-testid="goals-empty"
		/>
		<ListRow
			icon="today"
			title="A specific event"
			subtitle="A meet, race, fight or test day with a date"
			onpointerdown={preload}
			onclick={() => edit(newGoal())}
			data-testid="goal-path-event"
		/>
	{:else}
		<p class="rule" id="{id}-rule">
			<Icon name="info" size={16} />When goals compete for time or recovery, the higher one wins.
		</p>
		<ol class="ranked" aria-describedby="{id}-rule" data-testid="goal-list">
			{#each ranked as goal, i (goal.id)}
				{@const summary = goalSummary(goal)}
				<li>
					<button
						type="button"
						class="goal"
						class:top={i === 0}
						onpointerdown={preload}
						onclick={() => edit(goalDraft(goal))}
						data-testid="goal-row"
					>
						<span class="rank numeric" aria-hidden="true">{i + 1}</span>
						<span class="text">
							<span class="visually-hidden">Priority {i + 1}:</span>
							<span class="heading">
								<span class="title">{goal.title}</span>
								{#if i === 0}<Badge tone="accent">Top priority</Badge>{/if}
							</span>
							{#if summary}<span class="summary">{summary}</span>{/if}
							<span class="chips">
								{#each goal.disciplines as discipline (discipline)}
									<Chip tone={DISCIPLINE_INFO[discipline].tone}>
										{discipline === 'custom' && goal.customDiscipline
											? goal.customDiscipline
											: DISCIPLINE_INFO[discipline].short}
									</Chip>
								{/each}
							</span>
						</span>
						<span class="chevron"><Icon name="chevron-right" size={20} /></span>
					</button>
				</li>
			{/each}
		</ol>
		<Button
			variant="secondary"
			icon="plus"
			block
			onpointerdown={preload}
			onclick={() => edit(newGoal())}
			data-testid="add-goal"
		>
			Add a goal
		</Button>
	{/if}

	{#if unavailable}
		<div class="unavailable">
			<Notice tone="danger" title="Goals can’t be edited right now" data-testid="goals-error">
				Check your connection, then try again.
			</Notice>
			<!-- A reload: the browser keeps a failed module fetch for the life of the page. -->
			<Button variant="secondary" icon="refresh" onclick={() => location.reload()}>Retry</Button>
		</div>
	{/if}
</div>

{#if Sheet && draft}
	<!-- One sheet per draft: a keyed block of one mounts it afresh for each goal opened. -->
	{#each [draft] as current (current)}
		<Sheet bind:open draft={current} onsaved={saved} />
	{/each}
{/if}

<style>
	.goals,
	.unavailable {
		display: grid;
		gap: var(--space-4);
	}

	.unavailable {
		justify-items: start;
		gap: var(--space-3);
	}

	.rule {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.ranked {
		display: grid;
		gap: var(--space-2);
		padding: 0;
		list-style: none;
	}

	/* One row per goal, shaped like ListRow, with the rank where ListRow has its icon. */
	.goal {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		width: 100%;
		padding: var(--space-3) var(--space-3) var(--space-3) var(--space-2);
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-border);
		background: var(--color-surface-1);
		box-shadow: var(--elevation-1);
		text-align: left;
		transition:
			transform var(--duration-fast) var(--ease-out),
			border-color var(--duration-fast) var(--ease-standard);
	}

	.goal.top {
		border-color: color-mix(in srgb, var(--color-accent) 40%, var(--color-border));
	}

	.goal:active {
		transform: scale(0.985);
		border-color: var(--color-border-strong);
		transition-duration: var(--duration-instant);
	}

	@media (hover: hover) and (pointer: fine) {
		.goal:hover {
			border-color: var(--color-border-strong);
		}
	}

	.rank {
		flex: none;
		width: 2.5rem;
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
		text-align: center;
		color: var(--color-text-tertiary);
	}

	.top .rank {
		color: var(--color-accent-text);
	}

	.text {
		display: grid;
		flex: 1;
		gap: var(--space-1);
		min-width: 0;
	}

	.heading {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.title {
		font-weight: var(--weight-semibold);
	}

	.summary {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1-5);
		margin-top: var(--space-1);
	}

	.chevron {
		display: grid;
		color: var(--color-text-tertiary);
	}
</style>
