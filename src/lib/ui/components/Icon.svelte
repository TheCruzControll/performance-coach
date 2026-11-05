<!--
  @component
  Inline SVG icon from the product icon set. Decorative by default (aria-hidden); pass
  `label` when the icon alone conveys meaning.
-->
<script lang="ts">
	import { icons, type IconName } from '../icons/icons';

	interface Props {
		name: IconName;
		size?: number;
		strokeWidth?: number;
		label?: string;
		class?: string;
	}

	let { name, size = 24, strokeWidth = 1.75, label, class: className }: Props = $props();

	const paths = $derived(
		icons[name].map((d) =>
			d.startsWith('fill:') ? { d: d.slice(5), fill: true } : { d, fill: false }
		)
	);
</script>

<svg
	class={['icon', className]}
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width={strokeWidth}
	stroke-linecap="round"
	stroke-linejoin="round"
	role={label ? 'img' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
	focusable="false"
>
	{#each paths as path (path.d)}
		<path
			d={path.d}
			fill={path.fill ? 'currentColor' : undefined}
			stroke={path.fill ? 'none' : undefined}
		/>
	{/each}
</svg>

<style>
	.icon {
		flex: none;
		display: inline-block;
		vertical-align: middle;
	}
</style>
