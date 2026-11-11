<!--
  @component
  How the strength view moves between exercises (PRD §7), loaded after the first render, so none
  of it weighs on /workout's first paint. Each move is a goTo: device state, stored with the
  workout, so a reload returns to it.
  - Previous and Next, in workout order, disabled at either end (focus then moves to the other,
    never to the page).
  - Under them, Up next (UpNext.svelte), which between exercises offers Start, once every
    exercise is done Finish workout, and always Add exercise (`onadd`, the strength view's
    picker).
  - A swipe across the card (`area`): left for the next exercise, right for the previous, by
    swipe.ts's thresholds. Any pointer swipes, a mouse too; the card has touch-action: pan-y, so a
    vertical drag scrolls and a sideways one never scrolls the page. Once the drag is sideways the
    card follows it 1:1 (a transform written on each pointermove, no render), giving way less and
    less past the first or the last exercise. On release a spring seeded with the drag's velocity
    brings the card to rest: back where it was, or, moving on, the new exercise in from the side
    the finger pulled it. The spring is a WAAPI animation, so it stays off the main thread, and a
    press catches the card where it is. With motion reduced the card follows the finger but lands
    at once. A drag that moved the card is not a tap on a set row.
  - Previous and Next bring the card in from the side it came from, unless motion is reduced.
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
	import {
		dragAxis,
		dragOffset,
		pushSample,
		release,
		releaseVelocity,
		springFrames
	} from './swipe.ts';
	import type { Ends, Sample } from './swipe.ts';

	interface Props {
		view: WorkoutView;
		/** The current exercise's card, which a swipe crosses. */
		area: HTMLElement;
		/** The active workout's store, its workout loaded: a move is written at once. */
		store: WorkoutStore;
		/** Finish workout, after the last exercise. */
		onfinish: () => void;
		/** Add exercise, in Up next: opens the picker (`onintent` fetches it). */
		onadd: (event: MouseEvent) => void;
		onintent: () => void;
	}

	let { view, area, store, onfinish, onadd, onintent }: Props = $props();
	const index = $derived(view.slots.indexOf(currentExercise(view)!));

	/** Makes the exercise at `position` current. */
	function goTo(position: number) {
		if (position === view.slots[index]?.position) return;
		store.dispatch({ type: 'goTo', workoutId: view.workout.id, position });
	}

	const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
	/** The card a swipe moves: the area clips it sideways while it moves (data-moving). */
	const card = () => area.firstElementChild as HTMLElement | null;
	const ends = (): Ends => ({ previous: index > 0, next: index < view.slots.length - 1 });
	/** The card's running spring or entrance, if any. */
	let motion: Animation | null = null;

	/** Plays `keyframes` on the card, the area clipping it until they end. */
	function play(keyframes: Keyframe[], options: KeyframeAnimationOptions) {
		const el = card();
		if (!el) return;
		motion?.cancel();
		el.style.transform = '';
		area.dataset.moving = '';
		const animation = el.animate(keyframes, options);
		motion = animation;
		const end = () => {
			if (motion !== animation) return;
			motion = null;
			delete area.dataset.moving;
		};
		animation.onfinish = end;
		animation.oncancel = end;
	}

	/** Stops the card's motion where it is, and returns its offset there (0 when still). */
	function halt(): number {
		const el = card();
		const animation = motion;
		if (!el || !animation) return 0;
		const offset = new DOMMatrix(getComputedStyle(el).transform).m41;
		motion = null;
		animation.cancel();
		el.style.transform = `translateX(${offset}px)`;
		return offset;
	}

	/** The card's spring from `from` px to rest, leaving at `velocity` px per ms. */
	function settle(from: number, velocity: number) {
		if (reduced() || from === 0) {
			motion?.cancel();
			const el = card();
			if (el) el.style.transform = '';
			delete area.dataset.moving;
			return;
		}
		const { offsets, duration } = springFrames(from, 0, velocity);
		play(
			offsets.map((x) => ({ transform: `translateX(${x}px)` })),
			{ duration, easing: 'linear' }
		);
	}

	/** The card's entrance from `side` (1: from the right, -1: from the left). */
	function enter(side: number) {
		halt();
		if (reduced()) return settle(0, 0);
		play(
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
		interface Drag {
			id: number;
			x: number;
			y: number;
			t: number;
			/** Where the card was when pressed: caught mid-spring, it is held from there. */
			base: number;
			axis: 'x' | 'y' | null;
			samples: Sample[];
		}
		let drag: Drag | null = null;
		let swiped = false;
		/** The card's offset with the pointer dx px from where it was pressed. */
		const offsetAt = (d: Drag, dx: number) => dragOffset(d.base + dx, area.clientWidth, ends());
		const down = (event: PointerEvent) => {
			swiped = false;
			if (event.button !== 0 || !event.isPrimary) return;
			const base = halt();
			drag = {
				id: event.pointerId,
				x: event.clientX,
				y: event.clientY,
				t: event.timeStamp,
				base,
				axis: base ? 'x' : null,
				samples: [{ x: event.clientX, t: event.timeStamp }]
			};
		};
		const move = (event: PointerEvent) => {
			const d = drag;
			if (event.pointerId !== d?.id) return;
			const dx = event.clientX - d.x;
			d.axis ??= dragAxis(dx, event.clientY - d.y);
			if (d.axis === 'y') {
				drag = null;
				return;
			}
			if (!d.axis) return;
			pushSample(d.samples, { x: event.clientX, t: event.timeStamp });
			const el = card();
			if (!el) return;
			area.dataset.moving = '';
			el.style.transform = `translateX(${offsetAt(d, dx)}px)`;
		};
		const up = (event: PointerEvent) => {
			const d = drag;
			if (event.pointerId !== d?.id) return;
			drag = null;
			const dx = event.clientX - d.x;
			const dy = event.clientY - d.y;
			if ((d.axis ?? dragAxis(dx, dy)) !== 'x') return;
			swiped = true;
			pushSample(d.samples, { x: event.clientX, t: event.timeStamp });
			const width = area.clientWidth;
			const ms = event.timeStamp - d.t;
			const { delta, from } = release({ offset: offsetAt(d, dx), dx, dy, ms, width, ends: ends() });
			const slot = view.slots[index + delta];
			if (delta && slot) goTo(slot.position);
			settle(from, releaseVelocity(d.samples));
		};
		const cancel = (event: PointerEvent) => {
			const d = drag;
			if (event.pointerId !== d?.id) return;
			drag = null;
			if (d.axis === 'x') settle(offsetAt(d, event.clientX - d.x), 0);
		};
		const click = (event: MouseEvent) => {
			if (!swiped) return;
			swiped = false;
			event.preventDefault();
			event.stopPropagation();
		};
		area.addEventListener('pointerdown', down);
		area.addEventListener('click', click, true);
		addEventListener('pointermove', move, { passive: true });
		addEventListener('pointerup', up);
		addEventListener('pointercancel', cancel);
		return () => {
			area.removeEventListener('pointerdown', down);
			area.removeEventListener('click', click, true);
			removeEventListener('pointermove', move);
			removeEventListener('pointerup', up);
			removeEventListener('pointercancel', cancel);
			motion?.cancel();
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
<UpNext {view} onstart={goTo} {onfinish} {onadd} {onintent} />

<style>
	.pager {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-3);
	}
</style>
