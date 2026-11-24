<!--
  @component
  Profile → Equipment (Paper, 9 · "Equipment", "What's there"): where the owner trains and what
  is there, so the coach never programs a movement the gym can't support. Three rows: where you
  train most opens a sheet to pick it, and what's there and what you have at home each open a
  tick list of their own (a sub-screen, subscreens.svelte.ts). No home kit is "Nothing", an empty
  list. Then anything else, in the owner's words. Saved with the section's Save.
-->
<script lang="ts">
	import {
		EQUIPMENT,
		EQUIPMENT_LABEL,
		GYM_TYPES,
		GYM_TYPE_INFO
	} from '#lib/domain/profile/catalog.ts';
	import type { EquipmentInput } from '#lib/domain/profile/schemas.ts';
	import ChoiceGroup from '../components/ChoiceGroup.svelte';
	import ListRow from '../components/ListRow.svelte';
	import PickRow from '../components/PickRow.svelte';
	import TextArea from '../components/TextArea.svelte';
	import type { EditorProps } from './editors';
	import { kitValue } from './equipment';
	import { useSubScreens } from './subscreens.svelte.ts';

	let { value = $bindable(), errors = {}, heading }: EditorProps<EquipmentInput> = $props();

	const places = GYM_TYPES.map((g) => ({
		value: g,
		label: GYM_TYPE_INFO[g].label,
		hint: GYM_TYPE_INFO[g].hint
	}));
	const kit = EQUIPMENT.map((e) => ({ value: e, label: EQUIPMENT_LABEL[e] }));

	/** The host's sub-screens: none where an editor is rendered alone (a test). */
	const subs = useSubScreens();
	const screen = $derived(subs?.top?.id);
</script>

{#if screen === 'kit'}
	<ChoiceGroup
		legend="What’s there?"
		hideLegend
		variant="card"
		multiple
		options={kit}
		bind:values={value.equipment}
		error={errors.equipment}
		data-testid="kit"
	/>
{:else if screen === 'home-kit'}
	<ChoiceGroup
		legend="At home"
		hideLegend
		variant="card"
		multiple
		options={kit}
		bind:values={value.homeEquipment}
		error={errors.homeEquipment}
		data-testid="home-kit"
	/>
{:else}
	<div class="equipment">
		<!-- Profile's rows start 20 px under the title (Paper); an onboarding step keeps its own room. -->
		<div class="rows" class:flush={!heading}>
			<PickRow
				label="Where you train most"
				options={places}
				bind:value={value.gymType}
				error={errors.gymType}
				data-testid="gym-type"
			/>
			<ListRow
				title="What’s there"
				value={kitValue(value.equipment)}
				aria-invalid={errors.equipment ? 'true' : undefined}
				onclick={() =>
					subs?.open({
						id: 'kit',
						title: 'What’s there',
						back: 'Equipment',
						lede: 'Tick everything you can use.'
					})}
				data-opens="kit"
				data-testid="kit-row"
			/>
			<ListRow
				title="What you have at home"
				value={kitValue(value.homeEquipment)}
				aria-invalid={errors.homeEquipment ? 'true' : undefined}
				onclick={() =>
					subs?.open({
						id: 'home-kit',
						title: 'What you have at home',
						back: 'Equipment',
						lede: 'For days you can’t get to the gym.'
					})}
				data-opens="home-kit"
				data-testid="home-kit-row"
			/>
		</div>
		<TextArea
			label="Anything else?"
			bind:value={() => value.notes ?? '', (notes) => (value.notes = notes || null)}
			error={errors.notes}
			optional
			rows={2}
			placeholder="The rack only goes to 140 kg"
			maxlength={300}
		/>
	</div>
{/if}

<style>
	/* 20 px from the rows to the notes (Paper). */
	.equipment {
		display: grid;
		gap: var(--space-5);
	}

	.rows {
		display: grid;
	}

	/* The editor starts 32 px under the title, for a field; rows start 20 under it. */
	.rows.flush {
		margin-top: calc(var(--space-5) - var(--space-8));
	}
</style>
