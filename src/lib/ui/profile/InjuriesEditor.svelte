<!--
  @component
  Injuries, limitations and movements to avoid. Each has an area, side, severity, the
  movements to stay away from, and whether it still affects training (resolved ones are kept
  for the coach's history). "None" is a perfectly good answer.
-->
<script lang="ts">
	import {
		BODY_AREAS,
		BODY_AREA_LABEL,
		SEVERITIES,
		SEVERITY_INFO,
		SIDES
	} from '#lib/domain/profile/catalog.ts';
	import type { FieldErrors, InjuryInput } from '#lib/domain/profile/schemas.ts';
	import Button from '../components/Button.svelte';
	import ChoiceGroup from '../components/ChoiceGroup.svelte';
	import EmptyState from '../components/EmptyState.svelte';
	import IconButton from '../components/IconButton.svelte';
	import TagInput from '../components/TagInput.svelte';
	import TextArea from '../components/TextArea.svelte';
	import Toggle from '../components/Toggle.svelte';
	import { injuryTitle } from './forms';

	interface Props {
		value: { injuries: InjuryInput[] };
		errors?: FieldErrors;
	}

	let { value = $bindable(), errors = {} }: Props = $props();

	const areas = BODY_AREAS.map((a) => ({ value: a, label: BODY_AREA_LABEL[a] }));
	const sides = SIDES.map((s) => ({
		value: s,
		label: s === 'both' ? 'Both' : s === 'left' ? 'Left' : 'Right'
	}));
	const severities = SEVERITIES.map((s) => ({ value: s, label: SEVERITY_INFO[s].label }));

	function add() {
		value.injuries.push({
			bodyArea: null as unknown as InjuryInput['bodyArea'],
			side: null,
			severity: 'mild',
			notes: null,
			avoid: [],
			active: true,
			since: null
		});
	}

	const err = (i: number, field: string) => errors[`injuries.${i}.${field}`];
</script>

<div class="injuries">
	{#if value.injuries.length === 0}
		<EmptyState
			icon="shield"
			tone="neutral"
			title="Nothing to work around"
			description="If something hurts or a movement is off-limits, add it — your coach will program around it."
		/>
	{/if}

	{#each value.injuries as injury, i (i)}
		<section class="injury" aria-labelledby={`injury-${i}`} data-testid="injury">
			<header class="head">
				<h2 class="name" id={`injury-${i}`}>
					{injury.bodyArea ? injuryTitle(injury) : 'New injury or limitation'}
				</h2>
				<IconButton
					icon="trash"
					size="sm"
					label={`Remove ${injury.bodyArea ? injuryTitle(injury) : 'this injury'}`}
					onclick={() => value.injuries.splice(i, 1)}
				/>
			</header>
			<ChoiceGroup
				legend="Where?"
				bind:value={injury.bodyArea}
				options={areas}
				error={err(i, 'bodyArea')}
				data-testid="injury-area"
			/>
			<ChoiceGroup legend="Side" bind:value={injury.side} options={sides} />
			<ChoiceGroup
				legend="How much does it limit you?"
				hint={injury.severity ? SEVERITY_INFO[injury.severity].hint : undefined}
				bind:value={injury.severity}
				options={severities}
				error={err(i, 'severity')}
				data-testid="injury-severity"
			/>
			<TagInput
				label="Movements to avoid"
				bind:value={injury.avoid}
				placeholder="e.g. Overhead press"
				error={err(i, 'avoid') ??
					Object.entries(errors).find(([k]) => k.startsWith(`injuries.${i}.avoid.`))?.[1]}
				data-testid="injury-avoid"
			/>
			<TextArea
				label="Notes"
				bind:value={() => injury.notes ?? '', (v) => (injury.notes = v || null)}
				optional
				rows={2}
				placeholder="What aggravates it, what helps…"
				maxlength={300}
			/>
			<Toggle
				label="Still affecting training"
				description={injury.active
					? 'The coach programs around it.'
					: 'Kept in your history as resolved.'}
				bind:checked={injury.active}
			/>
		</section>
	{/each}

	<Button variant="secondary" icon="plus" block onclick={add} data-testid="add-injury"
		>{value.injuries.length ? 'Add another' : 'Add an injury or limitation'}</Button
	>
</div>

<style>
	.injuries {
		display: grid;
		gap: var(--space-4);
	}

	.injury {
		display: grid;
		gap: var(--space-5);
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

	.name {
		flex: 1;
		font-family: var(--font-display);
		font-size: var(--text-lg);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-tight);
	}
</style>
