<!--
  @component
  The whole training profile at a glance, one block per onboarding step with a way back to
  edit it. Blank optional sections say so plainly ("Not told yet"), never as an error.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import {
		BASELINE_SOURCE_KIND,
		DISCIPLINE_INFO,
		EQUIPMENT_LABEL,
		EXPERIENCE_LEVEL_INFO,
		GYM_TYPE_INFO,
		RACE_DISTANCE_INFO,
		SEVERITY_INFO,
		disciplineLabel
	} from '#lib/domain/profile/catalog.ts';
	import { STEP_INFO, type OnboardingStep } from '#lib/domain/profile/onboarding.ts';
	import type { FieldErrors } from '#lib/domain/profile/schemas.ts';
	import type { TrainingProfile } from '#lib/domain/profile/types.ts';
	import { formatDuration } from '#lib/domain/units.ts';
	import Badge from '#lib/ui/components/Badge.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import {
		baselineSummary,
		commitmentSummary,
		daysText,
		goalSummary,
		injuryTitle,
		phaseLabel,
		scheduleSummary,
		trim
	} from '#lib/ui/profile/forms.ts';

	interface Props {
		profile: TrainingProfile;
		steps: OnboardingStep[];
		errors?: FieldErrors;
		href: (step: OnboardingStep) => string;
	}

	let { profile: p, steps, errors = {}, href }: Props = $props();

	const openGoals = $derived(p.goals.filter((g) => g.priority !== null));
	const likes = $derived(p.exercises.filter((e) => e.sentiment === 'like').map((e) => e.exercise));
	const dislikes = $derived(
		p.exercises.filter((e) => e.sentiment === 'dislike').map((e) => e.exercise)
	);
	const weight = $derived(p.bodyWeight[0]);
</script>

{#snippet block(step: OnboardingStep, content: Snippet, error?: string)}
	{#if steps.includes(step)}
		<section
			class="block"
			class:invalid={Boolean(error)}
			aria-labelledby={`sum-${step}`}
			data-testid={`summary-${step}`}
		>
			<header class="head">
				<h2 class="title" id={`sum-${step}`}>{STEP_INFO[step].title}</h2>
				<!-- eslint-disable svelte/no-navigation-without-resolve -- href() uses resolve() -->
				<a
					class="edit"
					href={href(step)}
					aria-label={`Edit ${STEP_INFO[step].title.toLowerCase()}`}
				>
					Edit <Icon name="chevron-right" size={16} />
				</a>
				<!-- eslint-enable svelte/no-navigation-without-resolve -->
			</header>
			{@render content()}
			{#if error}<p class="error" role="alert">{error}</p>{/if}
		</section>
	{/if}
{/snippet}

<div class="summary">
	{#snippet you()}
		<p class="line">{p.profile.name} · {p.profile.weightUnit} · {p.profile.distanceUnit}</p>
	{/snippet}
	{@render block('welcome', you)}

	{#snippet goals()}
		{#if openGoals.length}
			<ol class="ranked">
				{#each openGoals as goal, i (goal.id)}
					<li>
						<span class="rank numeric">{i + 1}</span>
						<span class="stack">
							<span class="strong">{goal.title}</span>
							<span class="muted">{goalSummary(goal)}</span>
						</span>
					</li>
				{/each}
			</ol>
		{:else}
			<p class="muted">No goals yet.</p>
		{/if}
	{/snippet}
	{@render block('goals', goals, errors.goals)}

	{#snippet experience()}
		{#if p.experience.length}
			<ul class="rows">
				{#each p.experience as e (e.id)}
					<li>
						<span
							class="dot"
							style:background={`var(--color-${DISCIPLINE_INFO[e.discipline].tone})`}
						></span>
						<span class="strong">{disciplineLabel(e.discipline, e.customLabel)}</span>
						<span class="muted"
							>{EXPERIENCE_LEVEL_INFO[e.level].label}{e.years != null
								? ` · ${e.years} yr`
								: ''}{e.sessionsPerWeek != null ? ` · ${e.sessionsPerWeek}/wk` : ''}</span
						>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="muted">Not told yet.</p>
		{/if}
	{/snippet}
	{@render block('experience', experience)}

	{#snippet strength()}
		{#if p.profile.baselinesUnknown}
			<p class="line" data-testid="summary-baselines-unknown">
				<Badge tone="accent">Week one</Badge> Your 1RMs are established from RPE-based sets.
			</p>
		{:else if p.baselines.length}
			<ul class="rows">
				{#each p.baselines as b (b.id)}
					<li>
						<span class="strong"
							>{b.lift === 'custom' ? b.customLabel : b.lift.replace(/_/g, ' ')}</span
						>
						<span class="muted">{baselineSummary(b)}</span>
						<Badge tone={BASELINE_SOURCE_KIND[b.source] === 'measured' ? 'positive' : 'neutral'}
							>{b.kind}</Badge
						>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="muted">No 1RMs — week one establishes them.</p>
		{/if}
	{/snippet}
	{@render block('strength', strength)}

	{#snippet specifics()}
		{#if p.running}
			<p class="line">
				<span class="strong">Running</span>
				<span class="muted"
					>{p.running.weeklyDistance != null
						? `${p.running.weeklyDistance} ${p.running.unit}/wk`
						: 'Volume not set'}{p.running.easyPaceSeconds
						? ` · easy ${formatDuration(p.running.easyPaceSeconds)}/${p.running.unit}`
						: ''}</span
				>
			</p>
			{#each p.running.races as r (r.id)}
				<p class="line muted">
					{r.distance === 'other'
						? `${r.customDistance} ${p.running.unit}`
						: RACE_DISTANCE_INFO[r.distance].label}
					in {formatDuration(r.timeSeconds)}
				</p>
			{/each}
		{/if}
		{#if p.muayThai}
			<p class="line">
				<span class="strong">Muay Thai</span>
				<span class="muted"
					>{p.muayThai.sessionsPerWeek ?? '–'} sessions · {p.muayThai.sparringPerWeek ?? '–'} sparring
					/wk{p.muayThai.fights != null ? ` · ${p.muayThai.fights} fights` : ''}</span
				>
			</p>
		{/if}
		{#if !p.running && !p.muayThai}<p class="muted">Not told yet.</p>{/if}
	{/snippet}
	{@render block('specifics', specifics)}

	{#snippet equipment()}
		{#if p.equipment?.gymType || p.equipment?.equipment.length}
			<p class="line">
				<span class="strong"
					>{p.equipment.gymType ? GYM_TYPE_INFO[p.equipment.gymType].label : 'Gym'}</span
				>
				<span class="muted">{p.equipment.equipment.map((e) => EQUIPMENT_LABEL[e]).join(', ')}</span>
			</p>
		{:else}
			<p class="muted">Not told yet.</p>
		{/if}
	{/snippet}
	{@render block('equipment', equipment)}

	{#snippet injuries()}
		{#if p.injuries.length}
			<ul class="rows">
				{#each p.injuries as injury (injury.id)}
					<li>
						<span class="strong">{injuryTitle(injury)}</span>
						<span class="muted"
							>{SEVERITY_INFO[injury.severity].label}{injury.avoid.length
								? ` · avoid ${injury.avoid.join(', ')}`
								: ''}</span
						>
						{#if !injury.active}<Badge>Resolved</Badge>{/if}
					</li>
				{/each}
			</ul>
		{:else}
			<p class="muted">None.</p>
		{/if}
	{/snippet}
	{@render block('injuries', injuries)}

	{#snippet exercises()}
		{#if likes.length || dislikes.length}
			{#if likes.length}<p class="line">
					<span class="strong">Enjoys</span> <span class="muted">{likes.join(', ')}</span>
				</p>{/if}
			{#if dislikes.length}<p class="line">
					<span class="strong">Avoids</span> <span class="muted">{dislikes.join(', ')}</span>
				</p>{/if}
		{:else}
			<p class="muted">No preferences yet.</p>
		{/if}
	{/snippet}
	{@render block('exercises', exercises)}

	{#snippet schedule()}
		<p class="line"><span class="strong">{scheduleSummary(p.schedule)}</span></p>
		{#if p.schedule.availableDays.length}<p class="line muted">
				Available {daysText(p.schedule.availableDays)}
			</p>{/if}
		{#each p.schedule.commitments as c (c.id)}
			<p class="line muted">{c.label} · {commitmentSummary(c)}</p>
		{/each}
	{/snippet}
	{@render block('schedule', schedule, errors.schedule)}

	{#snippet body()}
		{#if weight || p.profile.nutritionPhase || p.profile.targetWeight}
			<p class="line">
				{#if weight}<span class="strong numeric">{trim(weight.value)} {weight.unit}</span>{/if}
				<span class="muted"
					>{[
						phaseLabel(p.profile.nutritionPhase),
						p.profile.targetWeight
							? `target ${trim(p.profile.targetWeight)} ${p.profile.weightUnit}`
							: null
					]
						.filter(Boolean)
						.join(' · ')}</span
				>
			</p>
		{:else}
			<p class="muted">Not told yet.</p>
		{/if}
	{/snippet}
	{@render block('body', body)}
</div>

<style>
	.summary {
		display: grid;
		gap: var(--space-3);
	}

	.block {
		display: grid;
		gap: var(--space-2);
		padding: var(--space-4);
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-border);
		background: var(--color-surface-1);
	}

	.block.invalid {
		border-color: var(--color-danger);
	}

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin: calc(-1 * var(--space-2)) 0 0;
	}

	.title {
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
		color: var(--color-text-tertiary);
	}

	.edit {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		min-height: var(--touch-target);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		color: var(--color-accent-text);
	}

	.ranked,
	.rows {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.ranked li,
	.rows li {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-1) var(--space-2);
	}

	.rank {
		width: 1.25rem;
		font-weight: var(--weight-bold);
		color: var(--color-accent-text);
	}

	.stack {
		display: grid;
		flex: 1;
	}

	.line {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-1) var(--space-2);
		align-items: baseline;
	}

	.strong {
		font-weight: var(--weight-semibold);
		text-transform: none;
	}

	.rows .strong:first-letter {
		text-transform: uppercase;
	}

	.muted {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.dot {
		align-self: center;
		width: 7px;
		height: 7px;
		border-radius: 50%;
	}

	.error {
		font-size: var(--text-sm);
		color: var(--color-danger);
	}
</style>
