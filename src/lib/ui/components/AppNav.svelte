<!--
  @component
  Primary navigation, one element at every width (docs/design-system.md, Responsive layout →
  Shell). Below 1024 px a canvas tab bar fixed to the bottom, with a hairline above it and clear
  of the home indicator: the four tabs, 24 px icons and 12 px labels, the current one in text
  colour and 600 with no pill. From 1024 px a rail at the left, with Profile's avatar link at its
  foot (the avatar is hidden below 1024 px: Today opens Profile there). Each item is a real link
  (works without JS) with aria-current on the active screen, so the destinations, their order and
  the current one are the same in both. A pressed link is marked current on pointerdown.
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
		/** Profile: the avatar link at the foot of the rail (not a tab). */
		profile: NavItem;
		/** Current pathname; the item whose href prefixes it is active. */
		pathname: string;
	}

	let { items, profile, pathname }: Props = $props();

	/**
	 * The link under a finger or a pressed mouse button, marked current at once, as a native tab
	 * bar does on touch: the navigation (and with it the pathname) starts only on click. Kept for
	 * a moment after the release, until the navigation has begun; let go at once when the press
	 * is cancelled or a mouse leaves the link, which never clicks.
	 */
	let pressed = $state<string | null>(null);
	let release: ReturnType<typeof setTimeout> | undefined;
	const RELEASE_MS = 300;

	function press(event: PointerEvent, href: string) {
		if (!event.isPrimary || event.button !== 0) return;
		if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
		clearTimeout(release);
		pressed = href;
	}

	function letGo(after = 0) {
		clearTimeout(release);
		release = setTimeout(() => (pressed = null), after);
	}

	const current = $derived(pressed ?? pathname);
	const isActive = (href: string) => current === href || current.startsWith(`${href}/`);
	const profileActive = $derived(isActive(profile.href));
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
					onpointerdown={(event) => press(event, item.href)}
					onpointerup={() => letGo(RELEASE_MS)}
					onpointercancel={() => letGo()}
					onpointerleave={(event) => {
						if (event.pointerType === 'mouse') letGo();
					}}
				>
					<Icon name={item.icon} size={24} strokeWidth={1.75} />
					<span class="label">{item.label}</span>
				</a>
			</li>
		{/each}
		<li class="profile">
			<a
				href={profile.href}
				class="avatar-link"
				aria-current={profileActive ? 'page' : undefined}
				data-sveltekit-preload-data="tap"
				data-testid="rail-avatar"
				onpointerdown={(event) => press(event, profile.href)}
				onpointerup={() => letGo(RELEASE_MS)}
				onpointercancel={() => letGo()}
				onpointerleave={(event) => {
					if (event.pointerType === 'mouse') letGo();
				}}
			>
				<Icon name={profile.icon} size={16} />
				<span class="visually-hidden">{profile.label}</span>
			</a>
		</li>
	</ul>
</nav>

<style>
	.app-nav {
		position: fixed;
		z-index: var(--z-nav);
		left: 0;
		right: 0;
		bottom: 0;
		/* The foot is in --nav-inset-bottom with the tabs and the hairline (tokens.css). */
		padding: var(--space-3) max(var(--space-7), var(--safe-right)) var(--nav-foot)
			max(var(--space-7), var(--safe-left));
		background: var(--color-canvas);
		border-top: 1px solid var(--color-hairline);
	}

	ul {
		display: flex;
		justify-content: space-between;
		max-width: var(--content-max);
		margin: 0 auto;
		padding: 0;
		list-style: none;
	}

	.item {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-1-5);
		width: 4rem;
		height: 2.875rem;
		font: var(--type-tab);
		color: var(--color-text-tertiary);
		transition: color var(--duration-fast) var(--ease-standard);
	}

	.item[aria-current='page'] {
		color: var(--color-text);
		font-weight: var(--weight-semibold);
	}

	.item:active :global(.icon) {
		transform: scale(0.9);
		transition-duration: var(--duration-instant);
	}

	.item:focus-visible {
		outline-offset: -2px;
		border-radius: var(--radius-sm);
	}

	@media (hover: hover) and (pointer: fine) {
		.item:not([aria-current]):hover {
			color: var(--color-text-secondary);
		}
	}

	/* Profile is the rail's last link: below 1024 px Today opens it. */
	.profile {
		display: none;
	}

	/*
	 * The rail (from 1024 px): solid, full height, the tabs stacked and the avatar at its foot.
	 * The brand mark above the tabs is layout.css's, until v2/03c.
	 */
	@media (width >= 64rem) {
		.app-nav {
			top: 0;
			right: auto;
			width: calc(var(--rail-width) + var(--safe-left));
			padding: calc(var(--safe-top) + var(--rail-mark) + 2 * var(--space-6)) 0
				calc(var(--safe-bottom) + var(--space-8)) var(--safe-left);
			background: var(--color-surface-1);
			border-top: 0;
			border-right: 1px solid var(--color-hairline);
		}

		ul {
			height: 100%;
			flex-direction: column;
			justify-content: flex-start;
			/* Each item and the avatar on the rail's centre line, not at its left edge. */
			align-items: center;
			gap: var(--space-7);
			max-width: none;
		}

		.item {
			height: auto;
			min-height: 3.5rem;
			gap: var(--space-1);
		}

		.profile {
			display: block;
			margin-top: auto;
		}
	}
</style>
