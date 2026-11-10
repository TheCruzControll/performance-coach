<!--
  @component
  How the strength view moves between exercises (PRD §7), loaded after the first render, so none
  of it weighs on /workout's first paint. Each move is a goTo: device state, stored with the
  workout, so a reload returns to it.
  - Previous and Next, in workout order, disabled at either end (focus then moves to the other,
    never to the page).
  - Under them, Up next (UpNext.svelte), which between exercises offers Start, and once every
    exercise is done Finish workout.
  - A swipe across the card (`area`): left for the next exercise, right for the previous, by
    swipe.ts's thresholds. Any pointer swipes, a mouse too; the card has touch-action: pan-y, so a
    vertical drag scrolls and a sideways one never scrolls the page. A swipe that ends on a set row
    is not a tap on it. The card enters from the side it came from, unless motion is reduced.
  - The side list (ExerciseList.svelte, from 1024 px): the arrows, Home and End move the focus
    along it, and Enter or a click makes an exercise current, focus staying on it.
  No keyboard shortcut is added (Alt+Arrow stays the browser's Back).
-->
<script lang="ts">
	import type { WorkoutStore } from '#lib/client/workout/store.ts';
	import type { WorkoutView } from '#lib/domain/workout/index.ts';
	import { currentExercise } from '#lib/domain/workout/selectors.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import UpNext from '#lib/ui/workout/UpNext.svelte';
	import { tick } from 'svelte';
	import { swipeStep } from './swipe.ts';

	interface Props {
		view: WorkoutView;
		/** The current exercise's card, which a swipe crosses. */
		area: HTMLElement;
		/** The active workout's store, its workout loaded: a move is written at once. */
		store: WorkoutStore;
		/** Finish workout, after the last exercise. */
		onfinish: () => void;
	}

	let { view, area, store, onfinish }: Props = $props();
	const index = $derived(view.slots.indexOf(currentExercise(view)!));

	/** Makes the exercise at `position` current. */
	function goTo(position: number) {
		if (position === view.slots[index]?.position) return;
		store.dispatch({ type: 'goTo', workoutId: view.workout.id, position });
	}

	/** The card's entrance from `side` (1: from the right, -1: from the left). */
	function enter(side: number) {
		if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
		area.animate(
			[
				{ opacity: 0, transform: `translateX(${side * 12}px)` },
				{ opacity: 1, transform: 'none' }
			],
			{ duration: 240, easing: 'cubic-bezier(0.2, 0, 0, 1)' }
		);
	}

	/** Previous (-1) or Next (1). */
	function step(delta: number) {
		const slot = view.slots[index + delta];
		if (!slot) return;
		const end = !view.slots[index + 2 * delta];
		goTo(slot.position);
		enter(delta);
		if (end && document.activeElement?.closest('.pager')) {
			const other = delta > 0 ? 'prev' : 'next';
			void tick().then(() =>
				document.querySelector<HTMLElement>(`[data-testid="exercise-${other}"]`)?.focus()
			);
		}
	}

	// The swipe across the card.
	$effect(() => {
		let drag: { id: number; x: number; y: number; t: number } | null = null;
		let swiped = false;
		const down = (event: PointerEvent) => {
			swiped = false;
			if (event.button !== 0 || !event.isPrimary) return;
			drag = { id: event.pointerId, x: event.clientX, y: event.clientY, t: event.timeStamp };
		};
		const up = (event: PointerEvent) => {
			if (event.pointerId !== drag?.id) return;
			const { x, y, t } = drag;
			drag = null;
			const dx = event.clientX - x;
			const delta = swipeStep(dx, event.clientY - y, event.timeStamp - t, area.clientWidth);
			if (delta === 0) return;
			swiped = true;
			step(delta);
		};
		const cancel = () => (drag = null);
		const click = (event: MouseEvent) => {
			if (!swiped) return;
			swiped = false;
			event.preventDefault();
			event.stopPropagation();
		};
		area.addEventListener('pointerdown', down);
		area.addEventListener('click', click, true);
		addEventListener('pointerup', up);
		addEventListener('pointercancel', cancel);
		return () => {
			area.removeEventListener('pointerdown', down);
			area.removeEventListener('click', click, true);
			removeEventListener('pointerup', up);
			removeEventListener('pointercancel', cancel);
		};
	});

	// The side list's rows.
	$effect(() => {
		const list = document.getElementById('exercise-list');
		if (!list) return;
		const rows = () => [...list.querySelectorAll('button')];
		const click = (event: MouseEvent) => {
			const row = (event.target as Element).closest<HTMLElement>('[data-position]');
			if (row) goTo(Number(row.dataset.position));
		};
		const key = (event: KeyboardEvent) => {
			const all = rows();
			const i = all.indexOf(event.target as HTMLButtonElement);
			const last = all.length - 1;
			const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: last }[event.key];
			if (i < 0 || to === undefined) return;
			event.preventDefault();
			all[Math.max(0, Math.min(last, to))]!.focus();
		};
		list.addEventListener('click', click);
		list.addEventListener('keydown', key);
		return () => {
			list.removeEventListener('click', click);
			list.removeEventListener('keydown', key);
		};
	});
</script>

<nav class="pager" aria-label="Previous and next exercise">
	<Button
		variant="secondary"
		icon="chevron-left"
		disabled={index <= 0}
		onclick={() => step(-1)}
		data-testid="exercise-prev">Previous</Button
	>
	<Button
		variant="secondary"
		iconEnd="chevron-right"
		disabled={index >= view.slots.length - 1}
		onclick={() => step(1)}
		data-testid="exercise-next">Next</Button
	>
</nav>

<!-- Last: Start, after an exercise's last set, grows the card where nothing follows it. -->
<UpNext {view} onstart={goTo} {onfinish} />

<style>
	.pager {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-3);
	}
</style>
