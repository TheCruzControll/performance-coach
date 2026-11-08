<!--
  @component
  History's list, newest first: the finished workouts this device has not synced yet ('Waiting to
  sync', not links: the server has no detail for them yet), then the completed ones. Each row is
  its discipline's dot, the title, the date and duration, and the number that matters for its
  kind, in words composed on the server (history.server.ts). A row is one link, ≥ 44 px, with
  hover, pressed and focus states, aria-current on the workout shown beside the list, and
  aria-busy with a progress line while it navigates. Rows keep focus and scroll when opened, so on
  a desktop window the list stays where it was; the page moves focus to the detail on a phone.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import { navigating } from '$app/state';
	import type { WaitingSummary } from '#lib/client/workout/probe.ts';
	import type { SessionKind } from '#lib/domain/training/types.ts';
	import Badge from '#lib/ui/components/Badge.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import type { WorkoutRowView } from './history.server';

	interface Props {
		rows: readonly WorkoutRowView[];
		waiting: readonly WaitingSummary[];
		/** The workout shown beside the list. */
		selected: string | null;
	}

	let { rows, waiting, selected }: Props = $props();

	const KIND_TONE: Record<SessionKind, string> = {
		strength: 'strength',
		run: 'running',
		other: 'conditioning'
	};
	/** 'Wed 4 Nov' on this device's calendar: only a workout waiting here is dated here. */
	const day = (at: string) =>
		new Date(at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
</script>

<ol class="rows" aria-label="Workouts">
	{#each waiting as workout (workout.workoutId)}
		<li class="row" data-testid="workout-waiting">
			<span class="dot" style:--tone={`var(--color-${KIND_TONE[workout.kind]})`}></span>
			<span class="text">
				<span class="title">{workout.title}</span>
				<span class="meta">{day(workout.startedAt)}</span>
			</span>
			<Badge icon="clock">Waiting to sync</Badge>
		</li>
	{/each}
	{#each rows as row (row.id)}
		{@const href = resolve('/(app)/progress/workouts/[[id]]', { id: row.id })}
		{@const pending = navigating.to?.url.pathname === href}
		<li>
			<a
				class="row link"
				{href}
				aria-current={row.id === selected ? 'page' : undefined}
				aria-busy={pending ? 'true' : undefined}
				data-sveltekit-keepfocus
				data-sveltekit-noscroll
				data-testid="workout-row"
			>
				<span class="dot" style:--tone={`var(--color-${row.tone})`}></span>
				<span class="text">
					<span class="title">{row.title}</span>
					<span class="meta">{row.meta}</span>
				</span>
				{#if row.figure}<span class="figure numeric">{row.figure}</span>{/if}
				<Icon name="chevron-right" size={20} class="chevron" />
				{#if pending}<span class="progress"></span>{/if}
			</a>
		</li>
	{/each}
</ol>

<style>
	.rows {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.row {
		position: relative;
		display: grid;
		grid-template-columns: auto minmax(0, 1fr) auto auto;
		align-items: center;
		column-gap: var(--space-3);
		min-height: var(--touch-target);
		padding: var(--space-3) var(--space-4);
		overflow: hidden;
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background: var(--color-surface-1);
		color: var(--color-text);
	}

	.link {
		transition:
			border-color var(--duration-fast) var(--ease-standard),
			background-color var(--duration-fast) var(--ease-standard);
	}

	.link:active {
		background: var(--color-surface-2);
		transition-duration: var(--duration-instant);
	}

	@media (hover: hover) and (pointer: fine) {
		.link:hover {
			border-color: var(--color-border-strong);
		}
	}

	.link:focus-visible {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	/* The workout shown beside the list: an accent edge and a lifted surface, and aria-current. */
	.link[aria-current='page'] {
		border-color: var(--color-accent);
		background: var(--color-surface-2);
	}

	.dot {
		width: 0.625rem;
		height: 0.625rem;
		border-radius: var(--radius-full);
		background: var(--tone);
	}

	.text {
		display: grid;
		min-width: 0;
	}

	.title {
		overflow: hidden;
		font-weight: var(--weight-semibold);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.meta,
	.figure {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.figure {
		font-weight: var(--weight-semibold);
		color: var(--color-text);
	}

	.row :global(.chevron) {
		color: var(--color-text-tertiary);
	}

	.link[aria-busy='true'] {
		cursor: progress;
	}

	/* Pending: a line sweeps along the row's bottom edge; still, under reduced motion. */
	.progress {
		position: absolute;
		inset: auto 0 0;
		height: 2px;
		background: linear-gradient(90deg, transparent, var(--color-accent-text), transparent);
		animation: sweep 1.2s var(--ease-standard) infinite;
	}

	@keyframes sweep {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(100%);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.progress {
			animation: none;
			opacity: 0.6;
		}
	}
</style>
