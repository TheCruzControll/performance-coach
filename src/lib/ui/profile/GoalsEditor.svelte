<!--
  @component
  Profile → Goals (PRD §2): the goals in priority order under a lede that says the higher one wins
  when goals compete, each a plain row that says when the goal is for (goals.ts `goalWhen`), or,
  with none yet, the question and the ways in: a specific event or a general goal, and in
  onboarding several at once too (added one by one, each ranked below the ones before, as a note
  under "Add another goal" says). A goal saves the moment it changes, through the route's
  `?/saveGoal` action, so the screen has no Save bar. The sheet that adds or edits a goal is
  code-split: it starts loading on first intent (pointerdown), and a tap that lands before it
  arrives still opens it. On Profile (`manage`) the sheet also pauses, achieves or drops a goal,
  and Past goals is one row away (/profile/goals/past).
  Each ranked goal moves up or down with its arrows: the list moves at once, the new rank is
  announced politely, `?/reorderGoals` stores it and its answer replaces the list; a failed save
  puts the order back and says so. A pointer can also drag a goal by the handle after its
  arrows; the handle is hidden from assistive tech and never focused, so the arrows stay the
  accessible way. Let go, the goal takes the place it was dragged to and is stored the same way.
  Whatever the priority trigger made of a change (a re-plan to review, or that none is needed)
  shows under the list as ReplanNotice, after a reorder, a save or a delete; its Try again runs
  `?/replan`. The notice never holds up the list.
-->
<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { applyAction } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { post } from '#lib/client/profile-form.ts';
	import type { Goal } from '#lib/domain/profile/types.ts';
	import Button from '../components/Button.svelte';
	import Icon from '../components/Icon.svelte';
	import IconButton from '../components/IconButton.svelte';
	import ListRow from '../components/ListRow.svelte';
	import Notice from '../components/Notice.svelte';
	import { toast } from '../toast.svelte';
	import type { EditorProps } from './editors';
	import { goalDraft, goalWhen, newGoal, type GoalDraft } from './goals';
	import type GoalSheet from './GoalSheet.svelte';
	import ReplanNotice from './ReplanNotice.svelte';
	import type { ReplanResult } from './replan-notice.ts';

	let { value = $bindable(), manage = false, heading }: EditorProps<Goal[]> = $props();
	const id = $props.id();

	/** Open goals, top priority first (achieved and dropped goals hold no rank). */
	const ranked = $derived(
		value.filter((g) => g.priority !== null).sort((a, b) => a.priority! - b.priority!)
	);
	/** Achieved and dropped goals: Past goals' row counts them (Profile only). */
	const past = $derived(value.filter((g) => g.priority === null));

	/** The device's date, for when each goal is for: known once mounted, never on the server. */
	let today = $state<Date | null>(null);
	onMount(() => (today = new Date()));

	let Sheet = $state<typeof GoalSheet | null>(null);
	let loading: Promise<unknown> | null = null;
	let unavailable = $state(false);
	let open = $state(false);
	let draft = $state.raw<GoalDraft | null>(null);
	/** Started from "Several goals at once": the next goal is asked for, and its rank explained. */
	let several = $state(false);

	/** The empty state's question, left out under a heading that already asks it (onboarding). */
	const EMPTY_TITLE = 'What are you training for?';
	const emptyTitle = $derived(heading === EMPTY_TITLE ? undefined : EMPTY_TITLE);

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

	/** The priority trigger's answer for the last goal change (ReplanNotice); null before one. */
	let replan = $state<ReplanResult | null>(null);
	/** Try again runs the trigger again: the notice is busy until it answers. */
	let checking = $state(false);

	function changed(goals: Goal[], message: string, next?: ReplanResult) {
		value = goals;
		if (next) replan = next;
		open = false;
		toast.show(message, { tone: 'positive' });
		// The Goals row's count on Profile is in the layout's answers: refresh them (Profile only).
		if (manage) void invalidate('app:profile-answers');
	}

	// ---- reordering ------------------------------------------------------------------------------
	let list = $state<HTMLElement>();
	/** What the polite live region last said: where the goal that moved is now. */
	let announcement = $state('');
	/** Orders are stored one after another, so the last one sent is the one kept. */
	let queue = Promise.resolve();
	/** Moves not answered yet: only the answer to the last one replaces the list. */
	let unanswered = 0;
	/** A failed save starts a new round, which drops the moves queued behind it. */
	let round = 0;

	function move(goal: Goal, by: -1 | 1, event: MouseEvent) {
		const ids = ranked.map((g) => g.id);
		const from = ids.indexOf(goal.id);
		const to = from + by;
		if (to < 0 || to >= ids.length) return;
		[ids[from], ids[to]] = [ids[to]!, ids[from]!];
		reorder(goal, ids);
		if (event.currentTarget === document.activeElement) void refocus(goal, by);
	}

	/** Rank the open goals in the order of `ids` now, and store it after the moves before it. */
	function reorder(goal: Goal, ids: string[]) {
		const before = value;
		value = value.map((g) => (g.priority === null ? g : { ...g, priority: ids.indexOf(g.id) + 1 }));
		announcement = `${goal.title} is now priority ${ids.indexOf(goal.id) + 1} of ${ids.length}`;
		unanswered++;
		const sent = round;
		queue = queue.then(() => store(ids, before, sent));
	}

	async function store(ids: string[], before: Goal[], sent: number) {
		const result = sent === round ? await post('?/reorderGoals', { ids }).catch(() => null) : null;
		unanswered--;
		if (sent !== round) return;
		if (result?.type === 'success') {
			if (unanswered === 0 && result.data) {
				value = result.data.goals as Goal[];
				if (result.data.replan) replan = result.data.replan as ReplanResult;
			}
		} else if (result?.type === 'redirect') {
			await applyAction(result); // the session ended: sign in again
		} else {
			round++;
			value = before;
			announcement = '';
			toast.show('The new order didn’t save. Try again.', { tone: 'danger' });
		}
	}

	/** Try again: the trigger runs again for the goals as they stand; a failure stays failed. */
	async function retry() {
		checking = true;
		const result = await post('?/replan').catch(() => null);
		checking = false;
		if (result?.type === 'success' && result.data?.replan) {
			replan = result.data.replan as ReplanResult;
		} else if (result?.type === 'redirect') {
			await applyAction(result); // the session ended: sign in again
		} else {
			replan = { state: 'failed' };
		}
	}

	/** The row moves under the arrow that moved it: keep focus there (the other arrow at an end). */
	async function refocus(goal: Goal, by: -1 | 1) {
		await tick();
		const row = list?.querySelector(`[data-goal="${goal.id}"]`);
		const [up, down] = row?.querySelectorAll<HTMLButtonElement>('.order button') ?? [];
		const next = by < 0 ? (up?.disabled ? down : up) : down?.disabled ? up : down;
		if (next !== document.activeElement) next?.focus();
	}

	// ---- dragging by the handle -----------------------------------------------------------------
	/**
	 * The goal being dragged: its rank when picked up (`from`), where it would land (`over`), how
	 * far it has moved, and each row's step (its height plus the gap), measured when picked up.
	 */
	let drag = $state<{ id: string; from: number; over: number; dy: number; steps: number[] }>();
	let pointer = { id: -1, y: 0 };

	const total = (steps: number[]) => steps.reduce((sum, step) => sum + step, 0);

	function grab(event: PointerEvent, goal: Goal, from: number) {
		if (!event.isPrimary || event.button !== 0 || !list) return;
		const gap = parseFloat(getComputedStyle(list).rowGap) || 0;
		const steps = [...list.children].map((row) => row.getBoundingClientRect().height + gap);
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		pointer = { id: event.pointerId, y: event.pageY };
		drag = { id: goal.id, from, over: from, dy: 0, steps };
	}

	/** The goal follows the pointer, within the list; it passes a row once past half its step. */
	function follow(event: PointerEvent) {
		if (!drag || event.pointerId !== pointer.id) return;
		const { from, steps } = drag;
		const dy = Math.max(
			-total(steps.slice(0, from)),
			Math.min(total(steps.slice(from + 1)), event.pageY - pointer.y)
		);
		const way = Math.sign(dy);
		let over = from;
		let left = Math.abs(dy);
		while (way && left > (steps[over + way] ?? Infinity) / 2) {
			over += way;
			left -= steps[over]!;
		}
		drag = { ...drag, dy, over };
	}

	function drop(event: PointerEvent) {
		if (!drag || event.pointerId !== pointer.id) return;
		const { id, over } = drag;
		drag = undefined;
		const ids = ranked.map((g) => g.id);
		const from = ids.indexOf(id);
		if (from < 0 || from === over) return;
		const goal = ranked[from]!;
		ids.splice(over, 0, ...ids.splice(from, 1));
		reorder(goal, ids);
	}

	/** How far row `i` is drawn from its place: the dragged one with the pointer, the rest aside. */
	function offset(i: number): number {
		if (!drag) return 0;
		const { from, over, dy, steps } = drag;
		if (i === from) return dy;
		if (from < i && i <= over) return -steps[from]!;
		if (over <= i && i < from) return steps[from]!;
		return 0;
	}
</script>

<div class="goals" data-testid="goals-editor">
	{#if ranked.length === 0}
		<div class="empty" data-testid="goals-empty">
			{#if emptyTitle}<h2 class="question">{emptyTitle}</h2>{/if}
			<p class="lede">Add a goal and the coach plans your training around it.</p>
		</div>
		<div class="paths">
			<ListRow
				title="A specific event"
				value="Race, fight, meet"
				onpointerdown={preload}
				onclick={() => start('event')}
				data-testid="goal-path-event"
			/>
			<ListRow
				title="A general goal"
				value="Stronger, faster, fitter"
				onpointerdown={preload}
				onclick={() => start('general')}
				data-testid="goal-path-general"
			/>
			{#if !manage}
				<!-- Onboarding only, until v2/05: Profile adds one goal, then another (Paper). -->
				<ListRow
					title="Several goals at once"
					value="One by one"
					onpointerdown={preload}
					onclick={() => start('several')}
					data-testid="goal-path-several"
				/>
			{/if}
		</div>
	{:else}
		<p class="lede" id="{id}-rule">
			What you’re training for, most important first. When goals compete, the higher one wins.
		</p>
		<ol
			class="ranked"
			class:sorting={drag !== undefined}
			aria-describedby="{id}-rule"
			data-testid="goal-list"
			bind:this={list}
		>
			{#each ranked as goal, i (goal.id)}
				{@const dy = offset(i)}
				<li
					class="row"
					class:lifted={drag?.id === goal.id}
					style:translate={dy ? `0 ${dy}px` : undefined}
					data-goal={goal.id}
				>
					<button
						type="button"
						class="goal"
						onpointerdown={preload}
						onclick={() => edit(goalDraft(goal))}
						data-testid="goal-row"
					>
						<span class="title"
							><span class="visually-hidden">Priority {i + 1}:</span> {goal.title}</span
						>
						{#if today}<span class="when">{goalWhen(goal, today)}</span>{/if}
						<span class="chevron"><Icon name="chevron-right" size={14} /></span>
					</button>
					{#if ranked.length > 1}
						<span class="order">
							<IconButton
								icon="chevron-down"
								label="Move {goal.title} up"
								disabled={i === 0}
								onclick={(event) => move(goal, -1, event)}
								data-testid="goal-up"
							/>
							<IconButton
								icon="chevron-down"
								label="Move {goal.title} down"
								disabled={i === ranked.length - 1}
								onclick={(event) => move(goal, 1, event)}
								data-testid="goal-down"
							/>
						</span>
						<span
							class="handle"
							aria-hidden="true"
							onpointerdown={(event) => grab(event, goal, i)}
							onpointermove={follow}
							onpointerup={drop}
							onpointercancel={() => (drag = undefined)}
							onlostpointercapture={() => (drag = undefined)}
							data-testid="goal-handle"
						></span>
					{/if}
				</li>
			{/each}
		</ol>
		<!-- A text link as wide as its words (Paper), not stretched across the column. -->
		<div>
			<Button
				variant="link"
				onpointerdown={preload}
				onclick={() => edit(newGoal())}
				aria-describedby={several ? `${id}-several` : undefined}
				data-testid="add-goal"
			>
				{several || ranked.length > 1 ? 'Add another goal' : 'Add a goal'}
			</Button>
		</div>
		{#if several}
			<p class="note" id="{id}-several" data-testid="goals-several-note">
				Goals rank in the order you add them, so add the next most important one.
			</p>
		{/if}
	{/if}

	{#if manage}
		<!-- Profile only: onboarding has no program to re-plan, and no ?/replan action. -->
		<ReplanNotice {replan} {checking} onretry={retry} />
	{/if}

	{#if manage && past.length > 0}
		<div class="past">
			<ListRow
				title="Past goals"
				value={String(past.length)}
				href={resolve('/(app)/profile/goals/past')}
				data-testid="past-goals"
			/>
		</div>
	{/if}

	<p class="visually-hidden" role="status" data-testid="goal-order-status">{announcement}</p>

	{#if unavailable}
		<div class="unavailable">
			<Notice tone="danger" title="Goals can’t be edited right now" data-testid="goals-error">
				Check your connection, then try again.
			</Notice>
			<!-- A reload: the browser keeps a failed module fetch for the life of the page. -->
			<Button variant="secondary" icon="refresh" onclick={() => location.reload()}>Try again</Button
			>
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
			onsaved={(goals, next) => changed(goals, 'Goal saved', next)}
			ondeleted={(goals, next) => changed(goals, 'Goal deleted', next)}
		/>
	{/each}
{/if}

<style>
	.goals,
	.unavailable {
		display: grid;
		gap: var(--space-4);
	}

	/* The question as a statement over its line: kept at the top, clear of the tab bar. */
	.empty {
		display: grid;
		gap: var(--space-4);
	}

	.question {
		font: var(--type-statement);
		letter-spacing: var(--tracking-statement);
	}

	.lede {
		font: var(--type-body);
		color: var(--color-text-secondary);
	}

	/* The ways in are ListRows, whose hairlines part them. */
	.paths {
		display: grid;
	}

	.note {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.unavailable {
		justify-items: start;
		gap: var(--space-3);
	}

	.ranked {
		display: grid;
		padding: 0;
		list-style: none;
	}

	/* A ranked goal, then its arrows: 44 px targets side by side with it, apart from each other. */
	.row {
		display: flex;
		gap: var(--space-2);
	}

	.row > .goal {
		flex: 1;
		min-width: 0;
	}

	.order {
		display: grid;
		flex: none;
		align-content: center;
		gap: var(--space-1);
	}

	/* The up arrow is the down chevron turned over: no icon of its own in every route's bundle. */
	.order > :global(:first-child svg) {
		transform: rotate(180deg);
	}

	/* A goal being dragged follows the pointer, raised; the rows it passes slide out of its way. */
	.sorting > .row {
		transition: translate var(--duration-base) var(--ease-out);
	}

	.sorting > .lifted {
		z-index: var(--z-raised);
		transition: none;
	}

	.lifted > .goal {
		background: var(--color-surface-2);
	}

	/*
	 * The handle: a narrow column flush with the arrows, whose circles already leave room around
	 * their glyphs, so the goal keeps its width. Its grip is six dots drawn here, so no icon joins
	 * every route's bundle.
	 */
	.handle {
		position: relative;
		display: grid;
		flex: none;
		place-items: center;
		width: 2rem;
		margin-inline-start: calc(-1 * var(--space-2));
		color: var(--color-text-tertiary);
		cursor: grab;
		touch-action: none;
		user-select: none;
		transition: color var(--duration-fast) var(--ease-standard);
	}

	.handle::before {
		content: '';
		width: 0.75rem;
		height: 1.125rem;
		background: radial-gradient(circle, currentColor 1.5px, transparent 2px) 0 0 / 6px 6px;
	}

	/* Its hit area is 44 px wide all the same: what it lacks comes from the gutter past its edge. */
	.handle::after {
		content: '';
		position: absolute;
		inset: 0 calc(2rem - var(--touch-target)) 0 0;
	}

	@media (hover: hover) and (pointer: fine) {
		.handle:hover {
			color: var(--color-text-secondary);
		}
	}

	.lifted .handle {
		color: var(--color-accent-text);
		cursor: grabbing;
	}

	/* One row per goal, drawn as ListRow draws one: its title, when it is for, a chevron; a
	   hairline under each but the last, and a tint reaching 8 px past it when pressed. */
	.goal {
		display: flex;
		align-items: center;
		gap: var(--space-3-5);
		width: 100%;
		min-height: 3.75rem;
		padding: var(--space-2) 0;
		border: 0;
		border-bottom: 1px solid var(--color-hairline);
		background: transparent;
		color: var(--color-text);
		text-align: left;
	}

	.row:last-child > .goal {
		border-bottom-color: transparent;
	}

	.goal:active {
		background: var(--color-surface-2);
		box-shadow: 0 0 0 var(--space-2) var(--color-surface-2);
	}

	@media (hover: hover) and (pointer: fine) {
		.goal:hover {
			background: var(--color-surface-2);
			box-shadow: 0 0 0 var(--space-2) var(--color-surface-2);
		}
	}

	.title {
		flex: 1;
		min-width: 0;
		font: var(--type-row);
	}

	.when {
		flex: none;
		font: var(--type-secondary);
		color: var(--color-text-secondary);
		font-variant-numeric: tabular-nums;
	}

	.chevron {
		display: grid;
		color: var(--color-text-tertiary);
	}

	.past {
		margin-top: var(--space-3);
	}
</style>
