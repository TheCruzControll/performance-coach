<!--
  @component
  Experience per discipline: level (required), years and current sessions a week (optional).
  The disciplines in the owner's goals are listed already; others can be added.
-->
<script lang="ts">
	import {
		DISCIPLINES,
		DISCIPLINE_INFO,
		EXPERIENCE_LEVELS,
		EXPERIENCE_LEVEL_INFO,
		disciplineLabel,
		type Discipline
	} from '#lib/domain/profile/catalog.ts';
	import type { FieldErrors } from '#lib/domain/profile/schemas.ts';
	import ChoiceGroup from '../components/ChoiceGroup.svelte';
	import IconButton from '../components/IconButton.svelte';
	import Notice from '../components/Notice.svelte';
	import NumberField from '../components/NumberField.svelte';
	import TextField from '../components/TextField.svelte';
	import { blankExperience, type ExperienceDraft } from './forms';

	interface Props {
		value: { entries: ExperienceDraft[] };
		errors?: FieldErrors;
	}

	let { value = $bindable(), errors = {} }: Props = $props();

	const addable = $derived(
		DISCIPLINES.filter((d) => d === 'custom' || !value.entries.some((e) => e.discipline === d))
	);
	const levels = EXPERIENCE_LEVELS.map((l) => ({
		value: l,
		label: EXPERIENCE_LEVEL_INFO[l].label
	}));

	let adding = $state<Discipline | null>(null);
	function add() {
		if (!adding) return;
		value.entries.push(blankExperience(adding));
		adding = null;
	}
</script>

<div class="experience">
	{#if value.entries.length === 0}
		<p class="empty">Add the disciplines you train — your goals’ disciplines appear here.</p>
	{/if}
	{#each value.entries as entry, i (`${entry.discipline}:${i}`)}
		{@const info = DISCIPLINE_INFO[entry.discipline]}
		<section class="entry" aria-labelledby={`exp-${i}`} data-testid="experience-entry">
			<header class="head">
				<span class="dot" style:background={`var(--color-${info.tone})`} aria-hidden="true"></span>
				<h2 class="name" id={`exp-${i}`}>
					{entry.discipline === 'custom' ? entry.customLabel || 'Your discipline' : info.label}
				</h2>
				<IconButton
					icon="close"
					size="sm"
					label={`Remove ${disciplineLabel(entry.discipline, entry.customLabel)}`}
					onclick={() => value.entries.splice(i, 1)}
				/>
			</header>
			{#if entry.discipline === 'custom'}
				<TextField
					label="Discipline"
					value={entry.customLabel ?? ''}
					oninput={(e) => (entry.customLabel = e.currentTarget.value)}
					error={errors[`entries.${i}.customLabel`]}
					maxlength={40}
				/>
			{/if}
			<ChoiceGroup
				legend="Level"
				hint={entry.level ? EXPERIENCE_LEVEL_INFO[entry.level].hint : undefined}
				bind:value={entry.level}
				options={levels}
				error={errors[`entries.${i}.level`]}
				data-testid="experience-level"
			/>
			<div class="pair">
				<NumberField
					label="Years"
					bind:value={entry.years}
					error={errors[`entries.${i}.years`]}
					optional
					data-testid="experience-years"
				/>
				<NumberField
					label="Sessions / week"
					bind:value={entry.sessionsPerWeek}
					error={errors[`entries.${i}.sessionsPerWeek`]}
					hint="Right now"
					optional
					data-testid="experience-frequency"
				/>
			</div>
		</section>
	{/each}

	{#if errors.entries}<Notice tone="danger">{errors.entries}</Notice>{/if}

	<div class="add">
		<ChoiceGroup
			legend="Also train something else?"
			bind:value={adding}
			onchange={add}
			options={addable.map((d) => ({
				value: d,
				label: d === 'custom' ? 'Other…' : DISCIPLINE_INFO[d].short,
				tone: DISCIPLINE_INFO[d].tone
			}))}
			data-testid="experience-add"
		/>
	</div>
</div>

<style>
	.experience {
		display: grid;
		gap: var(--space-4);
	}

	.entry {
		display: grid;
		gap: var(--space-4);
		padding: var(--space-4);
		border-radius: var(--radius-xl);
		border: 1px solid var(--color-border);
		background: var(--color-surface-1);
		box-shadow: var(--elevation-1);
	}

	.head {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin: calc(-1 * var(--space-1)) calc(-1 * var(--space-2)) 0 0;
	}

	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
	}

	.name {
		flex: 1;
		font-family: var(--font-display);
		font-size: var(--text-lg);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-tight);
	}

	.pair {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-3);
	}

	.empty {
		color: var(--color-text-secondary);
	}

	.add {
		padding-top: var(--space-2);
	}
</style>
