<!--
  @component
  The whole training profile at a glance, for onboarding's review: one block per step that
  applies, each with an Edit link back to its step (`href`). A part the owner has not told yet
  says so plainly ("Not told yet"), never as an error; what Start coaching needs and is missing
  (a goal, a schedule) is an alert on its block, and the first such block takes focus. Loaded on
  demand through the editors registry, so the review's initial JavaScript carries none of it.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import { DISCIPLINE_INFO, disciplineLabel } from '#lib/domain/profile/catalog.ts';
	import { STEP_INFO, type OnboardingStep } from '#lib/domain/profile/onboarding.ts';
	import type { FieldErrors } from '#lib/domain/profile/schemas.ts';
	import type { TrainingProfile } from '#lib/domain/profile/types.ts';
	import Badge from '#lib/ui/components/Badge.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import { goalSummary } from './goals';
	import { commitmentSummary, daysText, scheduleSummary } from './schedule';
	import { injuryTitle } from './injuries';
	import { liftName } from './strength';
	import {
		baselineValue,
		bodyLines,
		equipmentLines,
		experienceLine,
		injuryLine,
		muayThaiLine,
		raceLine,
		rankedGoals,
		runningLine
	} from './summary';

	interface Props {
		profile: TrainingProfile;
		/** The steps that apply, in order: a block for each but review. */
		steps: OnboardingStep[];
		/** Start coaching's errors, by the section they are about (`goals`, `schedule`). */
		errors?: FieldErrors;
		/** Where each block's Edit goes. */
		href: (step: OnboardingStep) => string;
	}

	let { profile: p, steps, errors = {}, href }: Props = $props();

	const goals = $derived(rankedGoals(p.goals));
	const weekOne = $derived(p.profile.baselinesUnknown || p.baselines.length === 0);
	const kit = $derived(equipmentLines(p.equipment));
	const body = $derived(bodyLines(p.profile, p.bodyWeight[0]));
	const likes = $derived(p.exercises.filter((e) => e.sentiment === 'like'));
	const dislikes = $derived(p.exercises.filter((e) => e.sentiment === 'dislike'));
	const names = (list: typeof likes) => list.map((e) => e.exercise).join(', ');

	const heading = (step: OnboardingStep) =>
		step === 'welcome' ? 'Name & units' : STEP_INFO[step].title;

	let root = $state<HTMLElement>();
	// Start coaching was refused: take the owner to the first block that needs them.
	$effect(() => {
		if (!Object.keys(errors).length) return;
		const edit = root?.querySelector<HTMLElement>('.block.invalid .edit');
		edit?.scrollIntoView({ block: 'center' });
		edit?.focus({ preventScroll: true });
	});
</script>

{#snippet untold()}<p class="muted">Not told yet</p>{/snippet}

{#snippet block(step: OnboardingStep, content: Snippet, error?: string)}
	{#if steps.includes(step)}
		<section
			class="block"
			class:invalid={Boolean(error)}
			aria-labelledby={`summary-${step}-title`}
			data-testid={`summary-${step}`}
		>
			<header class="head">
				<h2 class="title" id={`summary-${step}-title`}>{heading(step)}</h2>
				<a class="edit" href={href(step)} data-testid="summary-edit">
					Edit<span class="visually-hidden"> {heading(step)}</span>
					<Icon name="chevron-right" size={16} />
				</a>
			</header>
			{@render content()}
			{#if error}
				<p class="error" role="alert"><Icon name="alert" size={16} /> {error}</p>
			{/if}
		</section>
	{/if}
{/snippet}

{#snippet you()}
	<p class="line">
		<span class="strong">{p.profile.name || 'No name yet'}</span>
		<span class="muted">{p.profile.weightUnit} · {p.profile.distanceUnit}</span>
	</p>
{/snippet}

{#snippet goalList()}
	{#if goals.length}
		<ol class="rows">
			{#each goals as goal, i (goal.id)}
				<li class="ranked">
					<span class="rank numeric" aria-hidden="true">{i + 1}</span>
					<span class="stack">
						<span class="strong">{goal.title}</span>
						<span class="muted">{goalSummary(goal)}</span>
					</span>
				</li>
			{/each}
		</ol>
	{:else}
		{@render untold()}
	{/if}
{/snippet}

{#snippet experience()}
	{#if p.experience.length}
		<ul class="rows">
			{#each p.experience as e (e.id)}
				<li class="line">
					<span
						class="dot"
						aria-hidden="true"
						style:background={`var(--color-${DISCIPLINE_INFO[e.discipline].tone})`}
					></span>
					<span class="strong">{disciplineLabel(e.discipline, e.customLabel)}</span>
					<span class="muted">{experienceLine(e)}</span>
				</li>
			{/each}
		</ul>
	{:else}
		{@render untold()}
	{/if}
{/snippet}

{#snippet strength()}
	{#if weekOne}
		<p class="line" data-testid="summary-week-one">
			<Badge tone="accent">Week one</Badge>
			<span class="muted">Your 1RMs are found from RPE-based sets in your first week.</span>
		</p>
	{:else}
		<ul class="rows">
			{#each p.baselines as b (b.id)}
				<li class="line">
					<span class="strong">{liftName(b)}</span>
					<span class="numeric">{baselineValue(b)}</span>
					<Badge tone={b.kind === 'measured' ? 'positive' : 'neutral'}
						>{b.kind === 'measured' ? 'Measured' : 'Estimated'}</Badge
					>
				</li>
			{/each}
		</ul>
	{/if}
{/snippet}

{#snippet specifics()}
	{#if p.running || p.muayThai}
		<ul class="rows">
			{#if p.running}
				<li class="stack">
					<span class="strong">Running</span>
					<span class="muted">{runningLine(p.running) || 'Not told yet'}</span>
					{#each p.running.races as race (race.id)}
						<span class="muted">{raceLine(race, p.running.unit)}</span>
					{/each}
				</li>
			{/if}
			{#if p.muayThai}
				<li class="stack">
					<span class="strong">Muay Thai</span>
					<span class="muted">{muayThaiLine(p.muayThai) || 'Not told yet'}</span>
				</li>
			{/if}
		</ul>
	{:else}
		{@render untold()}
	{/if}
{/snippet}

{#snippet equipment()}
	{#if kit}
		<p class="stack">
			<span class="strong">{kit.place}</span>
			{#if kit.kit}<span class="muted">{kit.kit}</span>{/if}
			{#if kit.home}<span class="muted">At home: {kit.home}</span>{/if}
		</p>
	{:else}
		{@render untold()}
	{/if}
{/snippet}

{#snippet injuries()}
	{#if p.injuries.length}
		<ul class="rows">
			{#each p.injuries as injury (injury.id)}
				<li class="line">
					<span class="strong">{injuryTitle(injury)}</span>
					<span class="muted">{injuryLine(injury)}</span>
					{#if !injury.active}<Badge>Resolved</Badge>{/if}
				</li>
			{/each}
		</ul>
	{:else}
		{@render untold()}
	{/if}
{/snippet}

{#snippet exercises()}
	{#if likes.length || dislikes.length}
		<div class="rows">
			{#if likes.length}
				<p class="stack">
					<span class="strong">Enjoys</span> <span class="muted">{names(likes)}</span>
				</p>
			{/if}
			{#if dislikes.length}
				<p class="stack">
					<span class="strong">Rather skip</span> <span class="muted">{names(dislikes)}</span>
				</p>
			{/if}
		</div>
	{:else}
		{@render untold()}
	{/if}
{/snippet}

{#snippet schedule()}
	{#if p.schedule.daysPerWeek}
		<div class="rows">
			<p class="stack">
				<span class="strong">{scheduleSummary(p.schedule)}</span>
				{#if p.schedule.availableDays.length}
					<span class="muted">Available {daysText(p.schedule.availableDays)}</span>
				{/if}
			</p>
			{#each p.schedule.commitments as c (c.id)}
				<p class="stack">
					<span class="strong">{c.label}</span> <span class="muted">{commitmentSummary(c)}</span>
				</p>
			{/each}
		</div>
	{:else}
		{@render untold()}
	{/if}
{/snippet}

{#snippet bodyBlock()}
	{#if body}
		<p class="line">
			{#if body.weight}<span class="strong numeric">{body.weight}</span>{/if}
			{#if body.plan}<span class="muted">{body.plan}</span>{/if}
		</p>
	{:else}
		{@render untold()}
	{/if}
{/snippet}

<div class="summary" bind:this={root}>
	{@render block('welcome', you)}
	{@render block('goals', goalList, errors.goals)}
	{@render block('experience', experience)}
	{@render block('strength', strength)}
	{@render block('specifics', specifics)}
	{@render block('equipment', equipment)}
	{@render block('injuries', injuries)}
	{@render block('exercises', exercises)}
	{@render block('schedule', schedule, errors.schedule)}
	{@render block('body', bodyBlock)}
</div>

<style>
	.summary {
		display: grid;
		gap: var(--space-3);
	}

	.block {
		display: grid;
		gap: var(--space-2);
		padding: var(--space-2) var(--space-4) var(--space-4);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
		background: var(--color-surface-1);
		scroll-margin: var(--space-6);
	}

	.block.invalid {
		border-color: var(--color-danger);
	}

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.title {
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
		color: var(--color-text-tertiary);
	}

	/* The whole right of the header row is the target: 44 px tall, wider than its word. */
	.edit {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		min-width: var(--touch-target);
		min-height: var(--touch-target);
		margin-right: calc(-1 * var(--space-2));
		padding: 0 var(--space-2);
		border-radius: var(--radius-sm);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		color: var(--color-accent-text);
		transition: background-color var(--duration-fast) var(--ease-standard);
	}

	@media (hover: hover) and (pointer: fine) {
		.edit:hover {
			background: var(--color-surface-2);
		}
	}

	.rows {
		display: grid;
		gap: var(--space-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-1) var(--space-2);
	}

	.stack {
		display: grid;
		gap: 2px;
	}

	.ranked {
		display: flex;
		align-items: baseline;
		gap: var(--space-3);
	}

	.rank {
		min-width: 1ch;
		font-weight: var(--weight-bold);
		color: var(--color-accent-text);
	}

	.strong {
		font-weight: var(--weight-semibold);
	}

	.muted {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.dot {
		width: 8px;
		height: 8px;
		border-radius: var(--radius-full);
	}

	.error {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		color: var(--color-danger);
	}
</style>
