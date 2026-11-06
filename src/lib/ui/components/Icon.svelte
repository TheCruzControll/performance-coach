<!--
  @component
  SVG icon from the product icon set, drawn from one cached sprite (`<use href="sprite#name">`),
  so no icon path data ships in JavaScript. The sprite is generated from ../icons/icons.ts by
  `pnpm icons:sprite`. Decorative by default (aria-hidden); pass `label` when the icon alone
  conveys meaning.
-->
<script lang="ts">
	import type { IconName } from '../icons/icons';
	// Always a hashed file, never a data: URL (Chrome no longer draws data: URLs in <use>).
	import sprite from '../icons/sprite.svg?url&no-inline';

	interface Props {
		name: IconName;
		size?: number;
		strokeWidth?: number;
		label?: string;
		class?: string;
	}

	let { name, size = 24, strokeWidth = 1.75, label, class: className }: Props = $props();
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
	<use href="{sprite}#{name}" />
</svg>

<style>
	.icon {
		flex: none;
		display: inline-block;
		vertical-align: middle;
	}
</style>
