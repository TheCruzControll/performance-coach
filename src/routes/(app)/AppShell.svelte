<!--
  @component
  The app shell: the primary navigation (a bottom bar, a rail from 1024 px), a safe-area-aware
  content column centred beside it, and a connectivity notice. The nav comes before <main>, so
  on a desktop window Tab goes from the skip link through the rail to the content, as the eye
  reads it. Used by the (app) layout and by the root error page for app URLs, so a screen that
  fails to load (e.g. offline) never strands the user without navigation.
  On idle after hydration it loads the resume bar (ResumeBar.svelte), one dynamic import: the bar
  draws itself only when a workout waits on this device (or, on Today, on another one), so the
  offline screen, which the service worker serves inside this shell, is a way back into it too.
-->
<script lang="ts">
	import { onMount, type Component, type Snippet } from 'svelte';
	import { connectivity } from '#lib/client/connectivity.svelte.ts';
	import AppNav from '#lib/ui/components/AppNav.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import { APP_NAV } from './nav';

	interface Props {
		pathname: string;
		/** The screen is itself an offline/error state: no separate offline notice. */
		hideOfflineNotice?: boolean;
		children: Snippet;
	}

	let { pathname, hideOfflineNotice = false, children }: Props = $props();

	let ResumeBar = $state.raw<Component<{ pathname: string }> | null>(null);
	onMount(() => {
		connectivity.start();
		// A chunk gone after a deploy only means no bar until the next load.
		const load = () =>
			void import('./ResumeBar.svelte').then(
				(m) => (ResumeBar = m.default),
				() => {}
			);
		if ('requestIdleCallback' in window) requestIdleCallback(load, { timeout: 3000 });
		else setTimeout(load, 1500);
	});
</script>

<div class="shell">
	<AppNav items={APP_NAV} {pathname} />
	<main id="main" class="content" tabindex="-1">
		<div class="notice-region" role="status">
			{#if !connectivity.online && !hideOfflineNotice}
				<p class="offline-notice" data-testid="offline-notice">
					<Icon name="wifi-off" size={16} />
					<span><strong>Offline</strong> · Some screens need a connection</span>
				</p>
			{/if}
		</div>
		{@render children()}
	</main>
	{#if ResumeBar}<ResumeBar {pathname} />{/if}
</div>

<style>
	.shell {
		position: relative;
		min-height: 100dvh;
		padding-top: var(--safe-top);
		padding-bottom: calc(var(--nav-inset-bottom) + var(--space-8));
		padding-left: var(--nav-inset-left);
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
		max-width: var(--content-column);
		margin: 0 auto;
		padding: 0 max(var(--gutter), var(--safe-right)) 0 max(var(--gutter), var(--safe-left));
		outline: none;
	}

	.offline-notice {
		display: flex;
		align-items: center;
		gap: var(--space-2);
		margin-top: var(--space-3);
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-full);
		background: var(--color-surface-2);
		border: 1px solid var(--color-border);
		font-size: var(--text-xs);
		color: var(--color-text-secondary);
	}

	.offline-notice :global(.icon) {
		flex: none;
		color: var(--color-warning);
	}

	.offline-notice strong {
		font-weight: var(--weight-semibold);
		color: var(--color-text);
	}

	/*
	 * Tab changes cross-fade the page (the `root` snapshot) while the nav, named on its own, stays
	 * put (the bar and the rail alike). No view-transition-name on the content column: a named
	 * ancestor becomes a backdrop root and silently disables the blur of glass inside it (the
	 * coach composer).
	 */
	:global(.app-nav) {
		view-transition-name: app-nav;
	}

	:global(::view-transition-old(root)) {
		animation: 140ms var(--ease-in) both fade-out;
	}

	:global(::view-transition-new(root)) {
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
