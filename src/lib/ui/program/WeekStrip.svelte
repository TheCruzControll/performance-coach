<!--
  @component
  One week, Monday first: seven days in a thumb-width row that selects one (a radiogroup: roving
  tabindex, arrow keys, Home/End). A dot per session in its discipline's colour, a skipped one as
  a ring, hidden from assistive tech: each day's name says it instead ('Wednesday 4 November,
  today, 2 sessions, 1 done'). Today comes from the server (the owner's local date), never from
  the device clock, and is ringed. Every day fills its column, so at 393 px each stays ≥ 44 px
  wide even inside a padded card, and nothing scrolls sideways; a wide column shows 'Mon'. Sits
  on the canvas: the selected day is a raised surface. It lays out the words stripDay composed
  where the week was read (words.ts), so it ships no vocabulary.
-->
<script lang="ts">
	import type { IsoDate } from '#lib/domain/calendar.ts';
	import type { StripDayView } from './words.ts';

	interface Props {
		/** Seven days, Monday first. */
		days: readonly StripDayView[];
		/** The owner's local date, from the server; null when it is not this week. */
		today: IsoDate | null;
		selected?: IsoDate | null;
		/** The group's accessible name, e.g. 'Week 1'. */
		label: string;
		onselect?: (date: IsoDate) => void;
		'data-testid'?: string;
	}

	let {
		days,
		today,
		selected = $bindable(null),
		label,
		onselect,
		'data-testid': testId
	}: Props = $props();

	/** More dots than this would not fit a day; its name still counts every session. */
	const MAX_DOTS = 4;

	let buttons: HTMLButtonElement[] = $state([]);
	const index = (date: IsoDate | null) => days.findIndex((d) => d.date === date);
	// The one day Tab reaches: the selected day, else today, else Monday.
	const stop = $derived(Math.max(0, index(selected) >= 0 ? index(selected) : index(today)));

	function select(i: number, focus = false) {
		const day = days[i];
		if (!day) return;
		if (day.date !== selected) {
			selected = day.date;
			onselect?.(day.date);
		}
		if (focus) buttons[i]?.focus();
	}

	function onkeydown(event: KeyboardEvent, i: number) {
		const last = days.length - 1;
		const next = (
			{
				ArrowRight: i === last ? 0 : i + 1,
				ArrowDown: i === last ? 0 : i + 1,
				ArrowLeft: i === 0 ? last : i - 1,
				ArrowUp: i === 0 ? last : i - 1,
				Home: 0,
				End: last
			} as Record<string, number>
		)[event.key];
		if (next !== undefined) {
			event.preventDefault();
			select(next, true);
		}
	}
</script>

<div class="strip" role="radiogroup" aria-label={label} data-testid={testId}>
	{#each days as day, i (day.date)}
		<button
			bind:this={buttons[i]}
			type="button"
			role="radio"
			class="day"
			aria-checked={day.date === selected}
			aria-current={day.date === today ? 'date' : undefined}
			aria-label={day.name}
			tabindex={i === stop ? 0 : -1}
			onclick={() => select(i)}
			onkeydown={(event) => onkeydown(event, i)}
		>
			<span class="name letter">{day.letter}</span>
			<span class="name short">{day.short}</span>
			<span class="date numeric">{Number(day.date.slice(8))}</span>
			<span class="dots" aria-hidden="true">
				{#each day.dots.slice(0, MAX_DOTS) as dot, j (j)}
					<span class="dot" class:ring={dot.skipped} style:--tone={`var(--color-${dot.tone})`}
					></span>
				{/each}
			</span>
		</button>
	{/each}
</div>

<style>
	.strip {
		container-type: inline-size;
		display: grid;
		grid-template-columns: repeat(7, minmax(0, 1fr));
	}

	/* The button is the whole column (the hit area); the face is inset to leave a gap. */
	.day {
		position: relative;
		isolation: isolate;
		display: grid;
		justify-items: center;
		gap: var(--space-1);
		min-width: 0;
		min-height: var(--touch-target);
		padding: var(--space-2) 0;
		color: var(--color-text-secondary);
	}

	.day::before {
		content: '';
		position: absolute;
		inset: 0 3px;
		z-index: -1;
		border: 1px solid transparent;
		border-radius: var(--radius-md);
		transition:
			background-color var(--duration-fast) var(--ease-standard),
			border-color var(--duration-fast) var(--ease-standard),
			transform var(--duration-fast) var(--ease-out);
	}

	.day[aria-checked='true'] {
		color: var(--color-text);
	}

	.day[aria-checked='true']::before {
		background: var(--color-surface-1);
		border-color: var(--color-border);
		box-shadow: var(--elevation-1);
	}

	@media (hover: hover) {
		.day:hover::before {
			border-color: var(--color-border-strong);
		}
	}

	.day:active::before {
		transform: scale(0.95);
	}

	.day:focus-visible {
		outline: none;
	}

	.day:focus-visible::before {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 1px;
	}

	.name {
		font-size: var(--text-2xs);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
		color: var(--color-text-tertiary);
	}

	.short {
		display: none;
	}

	@container (min-width: 30rem) {
		.letter {
			display: none;
		}
		.short {
			display: inline;
		}
	}

	.date {
		display: grid;
		place-items: center;
		width: 1.875rem;
		aspect-ratio: 1;
		border-radius: 50%;
		font-size: var(--text-base);
		font-weight: var(--weight-semibold);
	}

	/* Today: a ring, not a colour alone. */
	.day[aria-current='date'] .date {
		box-shadow: inset 0 0 0 1.5px var(--color-accent-text);
		color: var(--color-text);
	}

	.dots {
		display: flex;
		gap: 3px;
		height: 6px;
	}

	.dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--tone);
	}

	.dot.ring {
		background: none;
		box-shadow: inset 0 0 0 1.5px var(--tone);
	}
</style>
