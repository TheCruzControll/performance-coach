<!--
  @component
  Profile → Experience: the owner's level in each discipline they train, with years and current
  sessions a week (both optional), so the coach starts each one at the right level. Disciplines
  of open goals are listed already. Others are added with a row of buttons, never a choice group
  (an arrow key would add every discipline it passed); a custom one needs a name. Any card can
  be removed.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import {
		DISCIPLINE_INFO,
		EXPERIENCE_LEVELS,
		EXPERIENCE_LEVEL_INFO,
		disciplineLabel,
		type Discipline
	} from '#lib/domain/profile/catalog.ts';
	import type { FieldErrors } from '#lib/domain/profile/schemas.ts';
	import Button from '../components/Button.svelte';
	import Card from '../components/Card.svelte';
	import ChoiceGroup from '../components/ChoiceGroup.svelte';
	import EmptyState from '../components/EmptyState.svelte';
	import IconButton from '../components/IconButton.svelte';
	import Notice from '../components/Notice.svelte';
	import NumberField from '../components/NumberField.svelte';
	import Section from '../components/Section.svelte';
	import TextField from '../components/TextField.svelte';
	import type { EditorProps } from './editors';
	import {
		addableDisciplines,
		blankExperience,
		errorsByRow,
		type ExperienceDraft,
		type ExperienceState
	} from './experience';

	let { value = $bindable(), errors = {} }: EditorProps<ExperienceState> = $props();

	const levels = EXPERIENCE_LEVELS.map((l) => ({
		value: l,
		label: EXPERIENCE_LEVEL_INFO[l].label
	}));
	const addable = $derived(addableDisciplines(value.entries));
	const nameOf = (entry: ExperienceDraft) =>
		disciplineLabel(entry.discipline, entry.customLabel?.trim());

	/**
	 * A save's errors, pinned to the rows that were there when they came back (and only then:
	 * not again when rows come and go), so a card removed afterwards takes its errors with it
	 * instead of handing them to the card that moves up.
	 */
	let pinnedFrom: FieldErrors | undefined;
	let pinned: Record<string, FieldErrors> = {};
	const rowErrors = $derived.by(() => {
		if (errors !== pinnedFrom) {
			pinnedFrom = errors;
			pinned = errorsByRow(errors, value.entries);
		}
		return pinned;
	});

	let root = $state<HTMLElement>();
	let announcement = $state('');
	let timer: ReturnType<typeof setTimeout> | undefined;

	/** Clear, then set: a live region speaks only when its text changes, even to the same words. */
	function announce(text: string) {
		announcement = '';
		clearTimeout(timer);
		timer = setTimeout(() => (announcement = text), 100);
	}

	const cards = () => [...(root?.querySelectorAll<HTMLElement>('.entry') ?? [])];

	async function add(discipline: Discipline) {
		value.entries.push(blankExperience(discipline, value.entries));
		announce(
			discipline === 'custom'
				? 'Added another discipline'
				: `Added ${DISCIPLINE_INFO[discipline].label}`
		);
		await tick();
		// Straight to what the new card needs first: a name for a custom one, else its level.
		const field = cards().at(-1)?.querySelector('input');
		field?.focus({ preventScroll: true });
		field?.scrollIntoView({ block: 'center' });
	}

	async function remove(index: number) {
		const entry = value.entries[index]!;
		const focused = cards()[index]?.contains(document.activeElement);
		value.entries.splice(index, 1);
		announce(`Removed ${nameOf(entry)}`);
		if (!focused) return;
		// Keep keyboard focus in the list: the next card's Remove, else the one before, else Add.
		await tick();
		const next = cards()[index] ?? cards()[index - 1];
		(next ?? root?.querySelector('.add'))?.querySelector('button')?.focus();
	}
</script>

<div class="experience" bind:this={root}>
	{#each value.entries as entry, i (entry.key)}
		{@const name = nameOf(entry)}
		{@const own = rowErrors[entry.key] ?? {}}
		<div class="entry">
			<Card
				title={name}
				tone={DISCIPLINE_INFO[entry.discipline].tone}
				data-testid="experience-entry"
			>
				{#snippet action()}
					<IconButton icon="close" size="sm" label="Remove {name}" onclick={() => remove(i)} />
				{/snippet}
				<div class="fields">
					{#if entry.discipline === 'custom'}
						<TextField
							label="What is it?"
							bind:value={() => entry.customLabel ?? '', (v) => (entry.customLabel = v || null)}
							error={own.customLabel}
							placeholder="Climbing, BJJ, rowing…"
							maxlength={40}
							autocapitalize="sentences"
							enterkeyhint="next"
						/>
					{/if}
					<ChoiceGroup
						legend="Level"
						hint={entry.level ? EXPERIENCE_LEVEL_INFO[entry.level].hint : 'Pick the closest fit.'}
						bind:value={entry.level}
						error={own.level}
						options={levels}
					/>
					<div class="pair">
						<NumberField
							label="Years"
							hint="Roughly is fine"
							bind:value={entry.years}
							error={own.years}
							optional
							enterkeyhint="next"
						/>
						<NumberField
							label="Sessions"
							unit="a week"
							hint="Right now"
							integer
							bind:value={entry.sessionsPerWeek}
							error={own.sessionsPerWeek}
							optional
						/>
					</div>
				</div>
			</Card>
		</div>
	{:else}
		<EmptyState
			compact
			icon="progress"
			title="No disciplines yet"
			description="Add each one you train, with your level in it: the coach starts every discipline from there."
			data-testid="experience-empty"
		/>
	{/each}

	{#if errors.entries}<Notice tone="danger">{errors.entries}</Notice>{/if}

	<div class="more">
		<Section title={value.entries.length ? 'Also train something else?' : 'What do you train?'}>
			<div class="add">
				{#each addable as discipline (discipline)}
					{@const label = discipline === 'custom' ? 'Other…' : DISCIPLINE_INFO[discipline].short}
					<Button
						variant="secondary"
						size="sm"
						icon="plus"
						aria-label={discipline === 'custom' ? 'Add other discipline' : `Add ${label}`}
						onclick={() => add(discipline)}
					>
						{label}
					</Button>
				{/each}
			</div>
		</Section>
	</div>

	<p class="visually-hidden" role="status">{announcement}</p>
</div>

<style>
	.experience {
		display: grid;
		gap: var(--space-4);
	}

	.fields {
		display: grid;
		gap: var(--space-5);
	}

	.pair {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-3);
	}

	.more {
		padding-top: var(--space-2);
	}

	.add {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
</style>
