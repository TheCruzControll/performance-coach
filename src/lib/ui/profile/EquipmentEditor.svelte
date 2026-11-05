<!--
  @component
  Where the owner trains and what is there — so the coach never programs a movement the gym
  can't support. Home equipment is separate (sessions at home, travel days).
-->
<script lang="ts">
	import {
		EQUIPMENT,
		EQUIPMENT_LABEL,
		GYM_TYPES,
		GYM_TYPE_INFO
	} from '#lib/domain/profile/catalog.ts';
	import type { EquipmentInput, FieldErrors } from '#lib/domain/profile/schemas.ts';
	import ChoiceGroup from '../components/ChoiceGroup.svelte';
	import TextArea from '../components/TextArea.svelte';
	import Toggle from '../components/Toggle.svelte';

	interface Props {
		value: EquipmentInput;
		errors?: FieldErrors;
	}

	let { value = $bindable(), errors = {} }: Props = $props();

	const items = EQUIPMENT.map((e) => ({ value: e, label: EQUIPMENT_LABEL[e] }));
	let home = $state(value.homeEquipment.length > 0);
</script>

<div class="equipment">
	<ChoiceGroup
		legend="Where do you train most?"
		variant="card"
		bind:value={value.gymType}
		error={errors.gymType}
		options={GYM_TYPES.map((g) => ({
			value: g,
			label: GYM_TYPE_INFO[g].label,
			hint: GYM_TYPE_INFO[g].hint
		}))}
		data-testid="gym-type"
	/>
	<ChoiceGroup
		legend="What’s there?"
		hint="Tap everything you can use."
		multiple
		bind:values={value.equipment}
		error={errors.equipment}
		options={items}
		data-testid="equipment-list"
	/>
	<Toggle
		label="I also train at home"
		description="Kit you have at home, for days you can’t get to the gym."
		bind:checked={home}
		onchange={(on) => {
			if (!on) value.homeEquipment = [];
		}}
	/>
	{#if home}
		<ChoiceGroup
			legend="At home"
			multiple
			bind:values={value.homeEquipment}
			options={items}
			data-testid="home-equipment"
		/>
	{/if}
	<TextArea
		label="Anything else?"
		bind:value={() => value.notes ?? '', (v) => (value.notes = v || null)}
		error={errors.notes}
		optional
		rows={2}
		placeholder="Rack only goes to 140 kg; no chalk allowed…"
		maxlength={300}
	/>
</div>

<style>
	.equipment {
		display: grid;
		gap: var(--space-6);
	}
</style>
