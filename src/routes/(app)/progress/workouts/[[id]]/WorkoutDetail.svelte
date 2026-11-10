<!--
  @component
  One completed workout, in words composed on the server (history.server.ts): its kind, date and
  time, title and key numbers; its PRs; each exercise with every set (RPE, and skipped, extra and
  missed in words) and its best estimated 1RM, labelled as an estimate; a run's segments
  (RunDetail) or a session's metrics (OtherDetail); substitutions, pain notes, notes, and the
  planned session against what was done. The title takes focus (tabindex -1) when a phone opens it.
  An exercise's name opens its history (ExerciseHistorySheet.svelte, loaded on intent), shallow-
  routed (pushState) so Back closes it; a reload shows the detail without it, and clears the
  reloaded entry's sheet so a later Back does not reopen it.
-->
<script lang="ts">
	import { afterNavigate, pushState, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import Icon from '#lib/ui/components/Icon.svelte';
	import { toast } from '#lib/ui/toast.svelte.ts';
	import type ExerciseHistorySheet from '#lib/ui/workout/ExerciseHistorySheet.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import Stat from '#lib/ui/components/Stat.svelte';
	import Surface from '#lib/ui/components/Surface.svelte';
	import type { WorkoutDetailView } from './history.server';
	import OtherDetail from './OtherDetail.svelte';
	import RunDetail from './RunDetail.svelte';

	let { detail }: { detail: WorkoutDetailView } = $props();

	let Sheet = $state.raw<typeof ExerciseHistorySheet | null>(null);
	const loadSheet = () =>
		import('#lib/ui/workout/ExerciseHistorySheet.svelte').then((m) => (Sheet = m.default));

	async function openHistory(exerciseId: string, name: string, event: MouseEvent) {
		// WebKit does not focus a clicked button: focus it, so closing the sheet returns focus here.
		(event.currentTarget as HTMLElement).focus();
		if (await loadSheet().catch(() => null))
			pushState('', { exerciseHistory: { exerciseId, name } });
		else toast.show('Couldn’t open its history. Try again.', { tone: 'danger' });
	}

	// A reload keeps an open sheet's state in its history entry, though not in page.state (SvelteKit
	// restores it only with persistState): Back from the next sheet would bring it back. Clear it.
	afterNavigate(({ type }) => {
		if (type === 'enter' && !page.state.exerciseHistory) void replaceState('', {});
	});
</script>

<article class="detail" aria-labelledby="workout-title" data-testid="workout-detail">
	<header class="head">
		<p class="eyebrow">
			<span class="dot" style:--tone={`var(--color-${detail.tone})`}></span>{detail.eyebrow}
		</p>
		<h2 id="workout-title" class="title" tabindex="-1">{detail.title}</h2>
	</header>

	{#if detail.stats.length}
		<div class="stats" data-testid="workout-stats">
			{#each detail.stats as stat (stat.label)}
				<Stat label={stat.label} value={stat.value} />
			{/each}
		</div>
	{/if}

	{#if detail.prs.length}
		<Section title="Personal records" data-testid="workout-prs">
			<ul class="lines">
				{#each detail.prs as pr (pr)}<li>{pr}</li>{/each}
			</ul>
		</Section>
	{/if}

	{#each detail.exercises as exercise (exercise.key)}
		<Surface as="section" padding="md" radius="lg" data-testid="workout-exercise">
			<h3 class="name">
				<button
					type="button"
					aria-haspopup="dialog"
					onclick={(event) => openHistory(exercise.exerciseId, exercise.name, event)}
					onpointerenter={loadSheet}
					data-testid="exercise-history-open"
					>{exercise.name}<Icon name="chevron-right" size={18} /></button
				>
			</h3>
			{#if exercise.best}<p class="best" data-testid="best-e1rm">{exercise.best}</p>{/if}
			<ol class="sets">
				{#each exercise.sets as set (set.key)}
					<li class="set" data-testid="workout-set">
						<span class="label">{set.label}</span>
						<span class="value numeric">{set.value}</span>
						{#if set.rpe}<span class="rpe">{set.rpe}</span>{/if}
						{#if set.mark}<span class="mark">{set.mark}</span>{/if}
					</li>
				{/each}
			</ol>
		</Surface>
	{/each}

	{#if detail.segments.length}<RunDetail segments={detail.segments} />{/if}
	{#if detail.metrics.length}<OtherDetail metrics={detail.metrics} />{/if}

	{#if detail.substitutions.length}
		<Section title="Substitutions" data-testid="workout-substitutions">
			<ul class="lines">
				{#each detail.substitutions as line (line)}<li>{line}</li>{/each}
			</ul>
		</Section>
	{/if}

	{#if detail.pain.length}
		<Section title="Pain" data-testid="workout-pain">
			<ul class="lines">
				{#each detail.pain as report (report.key)}
					<li>
						<span class="strong">{report.title}</span>
						{#if report.note}<span class="note">{report.note}</span>{/if}
					</li>
				{/each}
			</ul>
		</Section>
	{/if}

	{#if detail.notes.length}
		<Section title="Notes" data-testid="workout-notes">
			{#each detail.notes as note (note)}<p class="note">{note}</p>{/each}
		</Section>
	{/if}

	{#if Sheet}
		<Sheet request={page.state.exerciseHistory ?? null} onclose={() => history.back()} />
	{/if}

	{#if detail.planned}
		<Section title="Planned against done" data-testid="workout-planned">
			<p class="note">Planned: {detail.planned.title}</p>
			<dl class="pairs">
				{#each detail.planned.lines as line (line.key)}
					<div class="pair">
						<dt>{line.label}</dt>
						<dd>{line.value}</dd>
					</div>
				{/each}
			</dl>
		</Section>
	{/if}
</article>

<style>
	.detail {
		display: grid;
		gap: var(--space-5);
		min-width: 0;
	}

	.head {
		display: grid;
		gap: var(--space-1);
	}

	.eyebrow {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.dot {
		flex: none;
		width: 0.625rem;
		height: 0.625rem;
		border-radius: var(--radius-full);
		background: var(--tone);
	}

	.title {
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
		line-height: var(--leading-snug);
		overflow-wrap: anywhere;
	}

	.title:focus-visible {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	.stats {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(7rem, 1fr));
		gap: var(--space-2);
	}

	.name button {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		min-height: var(--touch-target);
		padding: 0;
		border: 0;
		background: none;
		color: inherit;
		font: inherit;
		font-weight: var(--weight-semibold);
		text-align: start;
		overflow-wrap: anywhere;
		cursor: pointer;
	}

	.name button:focus-visible {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
		border-radius: var(--radius-sm);
	}

	@media (hover: hover) and (pointer: fine) {
		.name button:hover {
			color: var(--color-accent-text);
		}
	}

	.best {
		margin-top: var(--space-1);
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.sets,
	.lines {
		display: grid;
		gap: var(--space-2);
		margin: var(--space-3) 0 0;
		padding: 0;
		list-style: none;
	}

	.lines {
		margin: 0;
	}

	.set {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		column-gap: var(--space-3);
		padding-top: var(--space-2);
		border-top: 1px solid var(--color-hairline);
	}

	.label {
		min-width: 4.5rem;
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.value,
	.strong {
		font-weight: var(--weight-semibold);
	}

	.rpe,
	.note {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.lines li {
		display: grid;
		gap: var(--space-1);
		line-height: var(--leading-snug);
	}

	/* Skipped, extra or missed: in words, on a tinted pill; colour only reinforces them. */
	.mark {
		padding: 0 var(--space-2);
		border-radius: var(--radius-full);
		background: var(--color-surface-2);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
		color: var(--color-text);
	}

	.pairs {
		display: grid;
		gap: var(--space-2);
		margin: 0;
	}

	.pair {
		display: flex;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.pair dd {
		margin: 0;
		color: var(--color-text-secondary);
		text-align: end;
	}
</style>
