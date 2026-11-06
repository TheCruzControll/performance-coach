<!--
  @component
  Profile → Goals (PRD §2): the goals in priority order, #1 marked "Top priority" because it wins
  when goals compete for time or recovery, or a designed empty state with PRD §2's three ways in:
  a specific event, a general goal, or several at once (added one by one, each ranked below the
  ones before, as a note under "Add another goal" says). A goal saves the moment it changes,
  through the route's `?/saveGoal` action, so the screen has no Save bar. The sheet that adds or
  edits a goal is code-split: it starts loading on first intent (pointerdown), and a tap that
  lands before it arrives still opens it. On Profile (`manage`) the sheet also pauses, achieves
  or drops a goal, and the goals that left the ranking are listed apart under Past goals.
-->
<script lang="ts">
	import { DISCIPLINE_INFO, GOAL_STATUS_LABEL } from '#lib/domain/profile/catalog.ts';
	import type { Goal } from '#lib/domain/profile/types.ts';
	import Badge from '../components/Badge.svelte';
	import Button from '../components/Button.svelte';
	import Chip from '../components/Chip.svelte';
	import EmptyState from '../components/EmptyState.svelte';
	import Icon from '../components/Icon.svelte';
	import ListRow from '../components/ListRow.svelte';
	import Notice from '../components/Notice.svelte';
	import Section from '../components/Section.svelte';
	import { toast } from '../toast.svelte';
	import type { EditorProps } from './editors';
	import { goalDraft, goalSummary, newGoal, type GoalDraft } from './goals';
	import type GoalSheet from './GoalSheet.svelte';

	let { value = $bindable(), manage = false }: EditorProps<Goal[]> = $props();
	const id = $props.id();

	/** Open goals, top priority first (achieved and dropped goals hold no rank). */
	const ranked = $derived(
		value.filter((g) => g.priority !== null).sort((a, b) => a.priority! - b.priority!)
	);
	/** Achieved and dropped goals, as the services list them: the latest to leave first. */
	const past = $derived(value.filter((g) => g.priority === null));

	let Sheet = $state<typeof GoalSheet | null>(null);
	let loading: Promise<unknown> | null = null;
	let unavailable = $state(false);
	let open = $state(false);
	let draft = $state.raw<GoalDraft | null>(null);
	/** Started from "Several goals at once": the next goal is asked for, and its rank explained. */
	let several = $state(false);

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

	function start(path: 'event' | 'general' | 'several') {
		several = path === 'several';
		edit(newGoal(path === 'general' ? 'general' : 'event'));
	}

	function changed(goals: Goal[], message: string) {
		value = goals;
		open = false;
		toast.show(message, { tone: 'positive' });
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
		<div class="paths">
			<ListRow
				icon="today"
				title="A specific event"
				subtitle="A meet, race, fight or test day"
				onpointerdown={preload}
				onclick={() => start('event')}
				data-testid="goal-path-event"
			/>
			<ListRow
				icon="progress"
				title="A general goal"
				subtitle="Get stronger, faster or fitter"
				onpointerdown={preload}
				onclick={() => start('general')}
				data-testid="goal-path-general"
			/>
			<ListRow
				icon="plus"
				title="Several goals at once"
				subtitle="One by one, top priority first"
				onpointerdown={preload}
				onclick={() => start('several')}
				data-testid="goal-path-several"
			/>
		</div>
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
								{#if goal.status === 'paused'}<Badge>Paused</Badge>{/if}
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
			aria-describedby={several ? `${id}-several` : undefined}
			data-testid="add-goal"
		>
			{several || ranked.length > 1 ? 'Add another goal' : 'Add a goal'}
		</Button>
		{#if several}
			<p class="note" id="{id}-several" data-testid="goals-several-note">
				Goals rank in the order you add them, so add the next most important one.
			</p>
		{/if}
	{/if}

	{#if manage && past.length > 0}
		<div class="past">
			<Section title="Past goals" data-testid="past-goals">
				<ul class="list">
					{#each past as goal (goal.id)}
						{@const summary = goalSummary(goal)}
						<li>
							<button
								type="button"
								class="goal closed"
								onpointerdown={preload}
								onclick={() => edit(goalDraft(goal))}
								data-testid="past-goal-row"
							>
								<span class="text">
									<span class="heading">
										<span class="title">{goal.title}</span>
										<Badge tone={goal.status === 'achieved' ? 'positive' : 'neutral'}>
											{GOAL_STATUS_LABEL[goal.status]}
										</Badge>
									</span>
									{#if summary}<span class="summary">{summary}</span>{/if}
								</span>
								<span class="chevron"><Icon name="chevron-right" size={20} /></span>
							</button>
						</li>
					{/each}
				</ul>
			</Section>
		</div>
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
		<Sheet
			bind:open
			draft={current}
			{manage}
			onsaved={(goals) => changed(goals, 'Goal saved')}
			ondeleted={(goals) => changed(goals, 'Goal deleted')}
		/>
	{/each}
{/if}

<style>
	.goals,
	.unavailable {
		display: grid;
		gap: var(--space-4);
	}

	.paths {
		display: grid;
		gap: var(--space-2);
	}

	.note {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
		text-align: center;
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

	.ranked,
	.list {
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

	/* Out of the ranking: no rank, and flat, so it reads as history rather than a goal in play. */
	.goal.closed {
		min-height: var(--touch-target);
		padding-left: var(--space-4);
		background: transparent;
		box-shadow: none;
	}

	.goal:active {
		transform: scale(0.985);
		border-color: var(--color-border-strong);
		transition-duration: var(--duration-instant);
	}

	@media (hover: hover) {
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

	.past {
		margin-top: var(--space-4);
	}
</style>
