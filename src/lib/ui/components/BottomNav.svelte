<!--
  @component
  Primary tab bar. Fixed to the bottom, glass background, respects the home-indicator safe
  area. Each item is a real link (works without JS) with aria-current on the active tab.
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

<nav class="bottom-nav" aria-label="Primary">
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
	.bottom-nav {
		position: fixed;
		z-index: var(--z-nav);
		left: 0;
		right: 0;
		bottom: 0;
		padding: 0 max(var(--space-2), var(--safe-right)) var(--safe-bottom)
			max(var(--space-2), var(--safe-left));
		background: var(--color-glass);
		backdrop-filter: saturate(160%) blur(22px);
		-webkit-backdrop-filter: saturate(160%) blur(22px);
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
</style>
