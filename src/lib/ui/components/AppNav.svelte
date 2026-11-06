<!--
  @component
  Primary navigation, one element at every width (docs/design-system.md, Responsive layout →
  Shell). Below 1024 px a glass tab bar fixed to the bottom, clear of the home indicator; from
  1024 px a solid rail at the left, under the brand mark that layout.css draws. Each item is a
  real link (works without JS) with aria-current on the active tab, so the destinations, their
  order and the current one are the same in both.
-->
<script lang="ts" module>
	import type { IconName } from '../icons/icons';

	export interface NavItem {
		href: string;
		label: string;
		icon: IconName;
	}
</script>

<script lang="ts">
	import Icon from './Icon.svelte';

	interface Props {
		items: NavItem[];
		/** Current pathname; the item whose href prefixes it is active. */
		pathname: string;
	}

	let { items, pathname }: Props = $props();

	const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
</script>

<nav class="app-nav" aria-label="Primary">
	<ul>
		{#each items as item (item.href)}
			{@const active = isActive(item.href)}
			<li>
				<a
					href={item.href}
					class="item"
					aria-current={active ? 'page' : undefined}
					data-sveltekit-preload-data="tap"
				>
					<span class="glyph">
						<Icon name={item.icon} size={24} strokeWidth={active ? 2 : 1.75} />
					</span>
					<span class="label">{item.label}</span>
				</a>
			</li>
		{/each}
	</ul>
</nav>

<style>
	.app-nav {
		position: fixed;
		z-index: var(--z-nav);
		left: 0;
		right: 0;
		bottom: 0;
		padding: 0 max(var(--space-2), var(--safe-right)) var(--safe-bottom)
			max(var(--space-2), var(--safe-left));
		background: var(--color-glass);
		backdrop-filter: saturate(180%) blur(32px);
		border-top: 1px solid var(--color-hairline);
	}

	ul {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		max-width: var(--content-max);
		margin: 0 auto;
		padding: 0;
		list-style: none;
	}

	.item {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 3px;
		height: var(--nav-height);
		color: var(--color-text-tertiary);
		transition: color var(--duration-fast) var(--ease-standard);
	}

	.glyph {
		display: grid;
		place-items: center;
		width: 3.25rem;
		height: 1.875rem;
		border-radius: var(--radius-full);
		transition:
			background-color var(--duration-base) var(--ease-standard),
			transform var(--duration-fast) var(--ease-out);
	}

	.label {
		font-size: var(--text-2xs);
		font-weight: var(--weight-semibold);
		letter-spacing: 0.01em;
	}

	.item[aria-current='page'] {
		color: var(--color-text);
	}

	.item[aria-current='page'] .glyph {
		background: var(--color-accent-subtle);
		color: var(--color-accent-text);
	}

	.item:active .glyph {
		transform: scale(0.9);
		transition-duration: var(--duration-instant);
	}

	.item:focus-visible {
		outline-offset: -4px;
		border-radius: var(--radius-md);
	}

	@media (hover: hover) and (pointer: fine) {
		.item:not([aria-current]):hover {
			color: var(--color-text-secondary);
		}

		.item:not([aria-current]):hover .glyph {
			background: var(--color-surface-2);
		}
	}

	/* The rail: solid, full height, items stacked under the brand mark (layout.css). */
	@media (width >= 64rem) {
		.app-nav {
			top: 0;
			right: auto;
			width: calc(var(--rail-width) + var(--safe-left));
			padding: calc(var(--safe-top) + var(--rail-mark) + 2 * var(--space-6)) 0 var(--safe-bottom)
				var(--safe-left);
			background: var(--color-surface-1);
			backdrop-filter: none;
			border-top: 0;
			border-right: 1px solid var(--color-hairline);
		}

		ul {
			grid-template-columns: minmax(0, 1fr);
			gap: var(--space-1);
			padding: 0 var(--space-1-5);
		}

		.item {
			height: auto;
			min-height: 3.5rem;
			gap: var(--space-1);
		}
	}
</style>
