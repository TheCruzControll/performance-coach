<!--
  @component
  Goals and their priority (PRD §2). Empty: three ways in — a specific event, a general goal,
  or several at once. Then a ranked list: #1 wins when goals compete for time or recovery.
  Reorder with the up/down buttons (one-handed, accessible) or by dragging the handle. Every
  change is saved at once through the page's goal actions (src/routes/profile-forms.server.ts);
  the editing sheet is code-split and loads on first intent.
-->
<script lang="ts">
	import type { Component } from 'svelte';
	import { post } from '#lib/client/profile-form.ts';
	import { DISCIPLINE_INFO, GOAL_STATUS_LABEL } from '#lib/domain/profile/catalog.ts';
	import type { Goal } from '#lib/domain/profile/types.ts';
	import Badge from '../components/Badge.svelte';
	import Button from '../components/Button.svelte';
	import Icon from '../components/Icon.svelte';
	import IconButton from '../components/IconButton.svelte';
	import Notice from '../components/Notice.svelte';
	import { toast } from '../toast.svelte';
	import { goalDraft, goalSummary, newGoal, type GoalDraft } from './forms';
	import type { GoalSheetProps } from './GoalSheet.svelte';

	interface Props {
		goals: Goal[];
		/** Profile: status changes and past goals. Onboarding: open goals only. */
		manage?: boolean;
		error?: string | null;
	}

	let { goals = $bindable(), manage = false, error = null }: Props = $props();

	const open = $derived(
		goals.filter((g) => g.priority !== null).sort((a, b) => a.priority! - b.priority!)
	);
	const closed = $derived(goals.filter((g) => g.priority === null));

	// ---- the editing sheet (code-split) ------------------------------------------------------
	let Sheet = $state<Component<GoalSheetProps> | null>(null);
	let sheetOpen = $state(false);
	let draft = $state<GoalDraft | null>(null);
	let several = $state(false);

	function loadSheet() {
		if (!Sheet) {
			void import('./GoalSheet.svelte').then(
				(m) => (Sheet = m.default as Component<GoalSheetProps>)
			);
		}
	}

	function edit(next: GoalDraft) {
		loadSheet();
		draft = next;
		sheetOpen = true;
	}

	function start(kind: 'event' | 'general' | 'several') {
		several = kind === 'several';
		edit(newGoal(kind === 'general' ? 'general' : 'event'));
	}

	function saved(list: Goal[], message: string) {
		goals = list;
		sheetOpen = false;
		toast.show(message, { tone: 'positive' });
	}

	// ---- reordering ----------------------------------------------------------------------------
	let announcement = $state('');

	async function reorder(ids: string[], moved: Goal) {
		const before = goals;
		// Optimistic: the list moves under the thumb now; the server confirms the ranking.
		goals = goals.map((g) => (g.priority === null ? g : { ...g, priority: ids.indexOf(g.id) + 1 }));
		announcement = `${moved.title} is now priority ${ids.indexOf(moved.id) + 1} of ${ids.length}`;
		try {
			const result = await post('?/reorderGoals', { ids });
			if (result.type !== 'success') throw new Error(result.type);
			goals = (result.data?.goals as Goal[] | undefined) ?? goals;
		} catch {
			goals = before;
			toast.show('Couldn’t save the new order. Try again.', { tone: 'danger' });
		}
	}

	function move(index: number, delta: -1 | 1) {
		const target = index + delta;
		if (target < 0 || target >= open.length) return;
		const ids = open.map((g) => g.id);
		[ids[index], ids[target]] = [ids[target]!, ids[index]!];
		void reorder(ids, open[index]!);
	}

	// ---- drag to reorder (the handle) -----------------------------------------------------------
	let drag = $state<{ from: number; over: number; dy: number; step: number } | null>(null);
	let startY = 0;

	function grab(event: PointerEvent, index: number) {
		if (event.button !== 0) return;
		const row = (event.currentTarget as HTMLElement).closest('li');
		const step = (row?.getBoundingClientRect().height ?? 80) + 8;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		startY = event.clientY;
		drag = { from: index, over: index, dy: 0, step };
	}

	function dragMove(event: PointerEvent) {
		if (!drag) return;
		const dy = event.clientY - startY;
		const over = Math.min(open.length - 1, Math.max(0, drag.from + Math.round(dy / drag.step)));
		drag = { ...drag, dy, over };
	}

	function drop() {
		if (!drag) return;
		const { from, over } = drag;
		drag = null;
		if (from === over) return;
		const ids = open.map((g) => g.id);
		const [id] = ids.splice(from, 1);
		ids.splice(over, 0, id!);
		void reorder(ids, open[from]!);
	}

	function shift(index: number): number {
		if (!drag) return 0;
		if (index === drag.from) return drag.dy;
		if (drag.from < drag.over && index > drag.from && index <= drag.over) return -drag.step;
		if (drag.from > drag.over && index < drag.from && index >= drag.over) return drag.step;
		return 0;
	}
</script>

<div class="goals" data-testid="goals-editor">
	{#if open.length === 0}
		<div class="paths" role="group" aria-label="What are you training for?">
			{#each [{ kind: 'event', icon: 'target', title: 'A specific event', text: 'A meet, race, fight or test day with a date' }, { kind: 'general', icon: 'progress', title: 'A general goal', text: 'Get stronger, build muscle, run faster, feel fitter' }, { kind: 'several', icon: 'sparkle', title: 'Several goals at once', text: 'E.g. a fight, keep my strength and a marathon' }] as const as path (path.kind)}
				<button
					type="button"
					class="path"
					onpointerdown={loadSheet}
					onclick={() => start(path.kind)}
					data-testid={`goal-path-${path.kind}`}
				>
					<span class="path-icon" aria-hidden="true"><Icon name={path.icon} size={22} /></span>
					<span class="path-text">
						<span class="path-title">{path.title}</span>
						<span class="path-sub">{path.text}</span>
					</span>
					<Icon name="chevron-right" size={20} />
				</button>
			{/each}
		</div>
	{:else}
		<p class="rule" id="goal-rule">
			<Icon name="info" size={16} /> When goals compete for time or recovery, the higher one wins.
		</p>
		<ol class="ranked" aria-describedby="goal-rule" data-testid="goal-list">
			{#each open as goal, i (goal.id)}
				<li
					class="goal"
					class:dragging={drag?.from === i}
					style:transform={shift(i) ? `translateY(${shift(i)}px)` : undefined}
					data-testid="goal-row"
					data-goal-id={goal.id}
				>
					<span class="rank numeric" aria-hidden="true">{i + 1}</span>
					<button
						type="button"
						class="main"
						onpointerdown={loadSheet}
						onclick={() => edit(goalDraft(goal))}
						aria-label={`Priority ${i + 1}: ${goal.title}. Edit`}
					>
						<span class="title-row">
							<span class="title" data-testid="goal-title">{goal.title}</span>
							{#if i === 0}<Badge tone="accent">Top priority</Badge>{/if}
							{#if goal.status === 'paused'}<Badge>Paused</Badge>{/if}
						</span>
						<span class="meta"
							>{goal.kind === 'event' ? 'Event' : 'General'} · {goalSummary(goal)}</span
						>
						<span class="chips">
							{#each goal.disciplines as d (d)}
								<span class="chip"
									><span
										class="dot"
										style:background={`var(--color-${DISCIPLINE_INFO[d].tone})`}
										aria-hidden="true"
									></span>{d === 'custom' && goal.customDiscipline
										? goal.customDiscipline
										: DISCIPLINE_INFO[d].short}</span
								>
							{/each}
						</span>
					</button>
					{#if open.length > 1}
						<span class="order">
							<IconButton
								icon="chevron-down"
								label={`Move ${goal.title} up`}
								size="sm"
								disabled={i === 0}
								onclick={() => move(i, -1)}
								data-testid="goal-up"
							/>
							<IconButton
								icon="chevron-down"
								label={`Move ${goal.title} down`}
								size="sm"
								disabled={i === open.length - 1}
								onclick={() => move(i, 1)}
								data-testid="goal-down"
							/>
						</span>
						<span
							class="handle"
							aria-hidden="true"
							onpointerdown={(e) => grab(e, i)}
							onpointermove={dragMove}
							onpointerup={drop}
							onpointercancel={() => (drag = null)}
						>
							<Icon name="grip" size={20} />
						</span>
					{/if}
				</li>
			{/each}
		</ol>
		<Button
			variant="secondary"
			icon="plus"
			block
			onpointerdown={loadSheet}
			onclick={() => edit(newGoal('event'))}
			data-testid="add-goal"
			>{several || open.length > 1 ? 'Add another goal' : 'Add a goal'}</Button
		>
		{#if several && open.length === 1}
			<p class="note">Add each goal, then put them in order of what matters most.</p>
		{/if}
	{/if}

	{#if error}<Notice tone="danger" data-testid="goals-error">{error}</Notice>{/if}

	{#if manage && closed.length > 0}
		<section class="past" aria-labelledby="past-goals">
			<h2 id="past-goals" class="past-title">Past goals</h2>
			<ul class="past-list">
				{#each closed as goal (goal.id)}
					<li>
						<button type="button" class="past-row" onclick={() => edit(goalDraft(goal))}>
							<span>{goal.title}</span>
							<Badge tone={goal.status === 'achieved' ? 'positive' : 'neutral'}
								>{GOAL_STATUS_LABEL[goal.status]}</Badge
							>
						</button>
					</li>
				{/each}
			</ul>
		</section>
	{/if}

	<p class="visually-hidden" role="status" aria-live="polite">{announcement}</p>
</div>

{#if Sheet}
	<Sheet
		bind:open={sheetOpen}
		{draft}
		{manage}
		onsaved={(list) => saved(list, 'Goal saved')}
		ondeleted={(list) => saved(list, 'Goal deleted')}
	/>
{/if}

<style>
	.goals {
		display: grid;
		gap: var(--space-4);
	}

	.paths {
		display: grid;
		gap: var(--space-3);
	}

	.path {
		display: flex;
		align-items: center;
		gap: var(--space-4);
		min-height: 4.5rem;
		padding: var(--space-4);
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-border);
		background: var(--color-surface-1);
		box-shadow: var(--elevation-1);
		text-align: left;
		color: var(--color-text-tertiary);
		transition: transform var(--duration-fast) var(--ease-out);
	}

	.path:active {
		transform: scale(0.98);
	}

	.path-icon {
		display: grid;
		flex: none;
		place-items: center;
		width: 2.75rem;
		height: 2.75rem;
		border-radius: var(--radius-md);
		background: var(--color-accent-subtle);
		color: var(--color-accent-text);
	}

	.path-text,
	.main {
		display: grid;
		flex: 1;
		gap: 2px;
		min-width: 0;
	}

	.path-title,
	.title {
		font-weight: var(--weight-semibold);
		color: var(--color-text);
	}

	.path-sub,
	.meta,
	.note {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.rule {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.ranked,
	.past-list {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.goal {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-2) var(--space-3) var(--space-3);
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-border);
		background: var(--color-surface-1);
		box-shadow: var(--elevation-1);
		transition: transform var(--duration-base) var(--ease-out);
	}

	.goal:first-child {
		border-color: color-mix(in srgb, var(--color-accent) 40%, var(--color-border));
	}

	.goal.dragging {
		z-index: var(--z-raised);
		position: relative;
		transition: none;
		box-shadow: var(--elevation-3);
	}

	.rank {
		flex: none;
		width: 1.75rem;
		font-family: var(--font-numeric);
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
		text-align: center;
		color: var(--color-text-tertiary);
	}

	.goal:first-child .rank {
		color: var(--color-accent-text);
	}

	.main {
		min-height: var(--touch-target);
		text-align: left;
	}

	.title-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.meta {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.chips {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1-5);
		margin-top: var(--space-1);
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		font-size: var(--text-xs);
		color: var(--color-text-secondary);
	}

	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
	}

	.order {
		display: grid;
		flex: none;
	}

	/* The up arrow is the down chevron turned over: one less icon in every screen's bundle. */
	.order :global(:first-child svg) {
		transform: rotate(180deg);
	}

	.handle {
		display: grid;
		flex: none;
		place-items: center;
		width: 2rem;
		align-self: stretch;
		color: var(--color-text-tertiary);
		cursor: grab;
		touch-action: none;
	}

	.past {
		display: grid;
		gap: var(--space-2);
		margin-top: var(--space-4);
	}

	.past-title {
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		color: var(--color-text-secondary);
	}

	.past-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
		min-height: var(--touch-target);
		padding: 0 var(--space-3);
		border-radius: var(--radius-md);
		background: var(--color-surface-1);
		text-align: left;
	}
</style>
