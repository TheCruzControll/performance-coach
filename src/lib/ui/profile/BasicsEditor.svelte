<!--
  @component
  Profile → Name & units, also onboarding's welcome step: what the coach calls the athlete and
  the units it plans and talks in. Saving also switches this device to those units (./basics.ts).
-->
<script lang="ts">
	import type { BasicsInput } from '#lib/domain/profile/schemas.ts';
	import SegmentedControl from '../components/SegmentedControl.svelte';
	import TextField from '../components/TextField.svelte';
	import type { EditorProps } from './editors';

	let { value = $bindable(), errors = {} }: EditorProps<BasicsInput> = $props();

	const WEIGHTS: { value: BasicsInput['weightUnit']; label: string }[] = [
		{ value: 'kg', label: 'kg' },
		{ value: 'lb', label: 'lb' }
	];
	const DISTANCES: { value: BasicsInput['distanceUnit']; label: string }[] = [
		{ value: 'km', label: 'km' },
		{ value: 'mi', label: 'mi' }
	];
</script>

<div class="basics">
	<TextField
		label="What should your coach call you?"
		hint="A first name or a nickname."
		bind:value={value.name}
		error={errors.name}
		autocomplete="given-name"
		autocapitalize="words"
		enterkeyhint="done"
		maxlength={64}
		data-testid="basics-name"
	/>
	<div class="units">
		<div class="unit">
			<span class="unit-label">Weights in</span>
			<SegmentedControl label="Weights in" bind:value={value.weightUnit} options={WEIGHTS} />
		</div>
		<div class="unit">
			<span class="unit-label">Distances in</span>
			<SegmentedControl label="Distances in" bind:value={value.distanceUnit} options={DISTANCES} />
		</div>
		<p class="note">Your coach plans in these units. Saving also switches this device to them.</p>
	</div>
</div>

<style>
	.basics {
		display: grid;
		gap: var(--space-6);
	}

	.units {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-3);
	}

	.unit {
		display: grid;
		gap: var(--space-2);
	}

	.unit-label {
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
	}

	.note {
		grid-column: 1 / -1;
		font-size: var(--text-xs);
		line-height: var(--leading-normal);
		color: var(--color-text-tertiary);
	}
</style>
