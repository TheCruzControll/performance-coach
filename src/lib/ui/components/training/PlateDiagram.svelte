<!--
  @component
  One sleeve of a loaded barbell, heaviest plate innermost. Plate colours follow the IWF
  convention for kg (lb plates map to the nearest kg colour), so the picture matches the gym.
-->
<script lang="ts">
	import type { WeightUnit } from '#lib/domain/units.ts';

	interface Props {
		plates: number[];
		unit: WeightUnit;
	}

	let { plates, unit }: Props = $props();

	// [kg-equivalent threshold, colour, height %, width px]
	const SPEC: [number, string, number, number][] = [
		[24, '#d8463b', 100, 22], // 25 kg — red
		[19, '#3a72d8', 100, 20], // 20 kg — blue
		[14, '#e3b737', 88, 17], // 15 kg — yellow
		[9, '#3aa66b', 76, 14], // 10 kg — green
		[4.5, '#e9e9e4', 56, 10], // 5 kg — white
		[2.2, '#d8463b', 46, 8], // 2.5 kg — red (small)
		[1, '#b9bcc2', 38, 6], // 1.25 kg — chrome
		[0, '#9a9ea6', 30, 5] // fractional — chrome
	];

	function spec(weight: number) {
		const kg = unit === 'kg' ? weight : weight * 0.45359237;
		const [, color, height, width] = SPEC.find(([min]) => kg >= min) ?? SPEC[SPEC.length - 1]!;
		return { color, height, width };
	}
</script>

<div
	class="diagram"
	role="img"
	aria-label={plates.length ? `Per side: ${plates.join(', ')} ${unit}` : 'Empty bar'}
>
	<span class="shaft" aria-hidden="true"></span>
	<span class="collar" aria-hidden="true"></span>
	<span class="plates" aria-hidden="true">
		{#each plates as weight, i (i)}
			{@const s = spec(weight)}
			<span
				class="plate"
				style:--plate={s.color}
				style:height={`${s.height}%`}
				style:width={`${s.width}px`}
				style:animation-delay={`${i * 40}ms`}
			></span>
		{/each}
	</span>
	<span class="sleeve" aria-hidden="true"></span>
</div>

<style>
	.diagram {
		display: flex;
		align-items: center;
		height: 7.5rem;
		padding: 0 var(--space-2);
	}

	.shaft {
		flex: 1;
		max-width: 5rem;
		height: 6px;
		border-radius: 3px 0 0 3px;
		background: linear-gradient(180deg, #8d9098, #5b5e66);
	}

	.collar {
		width: 8px;
		height: 30px;
		border-radius: 2px;
		background: linear-gradient(90deg, #6f727a, #a5a8b0 50%, #6f727a);
	}

	.plates {
		display: flex;
		align-items: center;
		gap: 2px;
		height: 100%;
		padding: 0 2px;
	}

	.plate {
		display: block;
		border-radius: 3px;
		background: linear-gradient(
			90deg,
			color-mix(in srgb, var(--plate) 72%, black),
			var(--plate) 45%,
			color-mix(in srgb, var(--plate) 80%, black)
		);
		box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.25);
		animation: slide-on var(--duration-slow) var(--ease-out) both;
	}

	.sleeve {
		flex: 1;
		min-width: 1.5rem;
		height: 14px;
		border-radius: 0 4px 4px 0;
		background: linear-gradient(180deg, #a5a8b0, #6f727a);
	}

	@keyframes slide-on {
		from {
			opacity: 0;
			transform: translateX(14px);
		}
	}
</style>
