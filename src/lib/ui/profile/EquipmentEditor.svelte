<!--
  @component
  Profile → Equipment: where the owner trains and what is there, so the coach never programs a
  movement the gym can't support. Home kit is separate (sessions at home, travel days).
-->
<script lang="ts">
	import {
		EQUIPMENT,
		EQUIPMENT_LABEL,
		GYM_TYPES,
		GYM_TYPE_INFO,
		type Equipment
	} from '#lib/domain/profile/catalog.ts';
	import type { EquipmentInput } from '#lib/domain/profile/schemas.ts';
	import ChoiceGroup from '../components/ChoiceGroup.svelte';
	import TextArea from '../components/TextArea.svelte';
	import Toggle from '../components/Toggle.svelte';
	import type { EditorProps } from './editors';

	let { value = $bindable(), errors = {} }: EditorProps<EquipmentInput> = $props();

	const places = GYM_TYPES.map((g) => ({
		value: g,
		label: GYM_TYPE_INFO[g].label,
		hint: GYM_TYPE_INFO[g].hint
	}));
	const kit = EQUIPMENT.map((e) => ({ value: e, label: EQUIPMENT_LABEL[e] }));

	// Home kit is listed while "I also train at home" is on. Turning it off empties the list;
	// turning it back on before saving brings the same items back.
	let home = $state(value.homeEquipment.length > 0);
	let stashed: Equipment[] = [];

	function trainAtHome(on: boolean) {
		if (on) {
			value.homeEquipment = stashed;
		} else {
			stashed = [...value.homeEquipment];
			value.homeEquipment = [];
		}
	}
</script>

<div class="equipment">
	<ChoiceGroup
		legend="Where do you train most?"
		variant="card"
		bind:value={value.gymType}
		error={errors.gymType}
		options={places}
	/>
	<ChoiceGroup
		legend="What’s there?"
		hint="Tap everything you can use."
		multiple
		bind:values={value.equipment}
		error={errors.equipment}
		options={kit}
	/>
	<div class="home">
		<Toggle
			label="I also train at home"
			description="What you have there, for days you can’t get to the gym."
			bind:checked={home}
			onchange={trainAtHome}
		/>
		{#if home}
			<ChoiceGroup
				legend="At home"
				multiple
				bind:values={value.homeEquipment}
				error={errors.homeEquipment}
				options={kit}
			/>
		{/if}
	</div>
	<TextArea
		label="Anything else?"
		bind:value={() => value.notes ?? '', (notes) => (value.notes = notes || null)}
		error={errors.notes}
		optional
		rows={2}
		placeholder="Rack only goes to 140 kg; no chalk…"
		maxlength={300}
	/>
</div>

<style>
	.equipment {
		display: grid;
		gap: var(--space-6);
	}

	.home {
		display: grid;
		gap: var(--space-3);
	}
</style>
