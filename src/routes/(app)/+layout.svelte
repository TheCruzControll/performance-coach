<script lang="ts">
	import { onNavigate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import BottomNav, { type NavItem } from '#lib/ui/components/BottomNav.svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	const nav: NavItem[] = [
		{ href: resolve('/(app)/today'), label: 'Today', icon: 'today' },
		{ href: resolve('/(app)/train'), label: 'Train', icon: 'train' },
		{ href: resolve('/(app)/progress'), label: 'Progress', icon: 'progress' },
		{ href: resolve('/(app)/coach'), label: 'Coach', icon: 'coach' },
		{ href: resolve('/(app)/profile'), label: 'Profile', icon: 'profile' }
	];

	// Cross-fade between tabs with the View Transitions API where available.
	onNavigate((navigation) => {
		if (
			!document.startViewTransition ||
			navigation.from?.url.pathname === navigation.to?.url.pathname ||
			matchMedia('(prefers-reduced-motion: reduce)').matches
		) {
			return;
		}
		return new Promise((done) => {
			document.startViewTransition(async () => {
				done();
				await navigation.complete;
			});
		});
	});
</script>

<div class="shell">
	<main id="main" class="content" tabindex="-1">
		{@render children()}
	</main>
	<BottomNav items={nav} pathname={page.url.pathname} />
</div>

<style>
	.shell {
		position: relative;
		min-height: 100dvh;
		padding-top: var(--safe-top);
		padding-bottom: calc(var(--nav-height) + var(--safe-bottom) + var(--space-8));
		isolation: isolate;
	}

	/* A whisper of the accent at the top edge: depth without decoration. */
	.shell::before {
		content: '';
		position: absolute;
		z-index: -1;
		inset: 0 0 auto;
		height: 22rem;
		pointer-events: none;
		background: radial-gradient(
			120% 70% at 50% -20%,
			color-mix(in srgb, var(--color-accent) 7%, transparent),
			transparent 70%
		);
	}

	.content {
		width: 100%;
		max-width: var(--content-max);
		margin: 0 auto;
		padding: 0 max(var(--gutter), var(--safe-right)) 0 max(var(--gutter), var(--safe-left));
		outline: none;
		view-transition-name: page;
	}

	:global(.bottom-nav) {
		view-transition-name: bottom-nav;
	}

	:global(::view-transition-old(page)) {
		animation: 140ms var(--ease-in) both fade-out;
	}

	:global(::view-transition-new(page)) {
		animation: 220ms var(--ease-out) both fade-in;
	}

	@keyframes -global-fade-out {
		to {
			opacity: 0;
		}
	}

	@keyframes -global-fade-in {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
	}
</style>
