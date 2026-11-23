<!--
  @component
  The app shell: the primary navigation (a bottom bar, a rail from 1024 px; the tab a navigation
  goes to is current from its start), a safe-area-aware content column centred beside it, and a
  connectivity notice. The nav comes before <main>, so
  on a desktop window Tab goes from the skip link through the rail to the content, as the eye
  reads it. Used by the (app) layout and by the root error page for app URLs, so a screen that
  fails to load (e.g. offline) never strands the user without navigation.
  On idle after hydration (or, without an idle callback, as on WebKit, once the first frame has
  painted) it loads the resume bar (ResumeBar.svelte), one dynamic import: the bar
  draws itself only when a workout waits on this device (or, on Today, on another one), so the
  offline screen, which the service worker serves inside this shell, is a way back into it too.
-->
<script lang="ts">
	import { onMount, type Component, type Snippet } from 'svelte';
	import { navigating } from '$app/state';
	import { connectivity } from '#lib/client/connectivity.svelte.ts';
	import AppNav from '#lib/ui/components/AppNav.svelte';
	import { afterPaint } from '../workout/lazy.ts';
	import { activePath, APP_NAV, PROFILE } from './nav';

	interface Props {
		pathname: string;
		/** The screen is itself an offline/error state: no separate offline notice. */
		hideOfflineNotice?: boolean;
		/** Drawn over the content while another screen loads ((app)/HeldScreen.svelte). */
		held?: Snippet;
		children: Snippet;
	}

	let { pathname, hideOfflineNotice = false, held, children }: Props = $props();

	let ResumeBar = $state.raw<Component<{ pathname: string }> | null>(null);
	onMount(() => {
		connectivity.start();
		// A chunk gone after a deploy only means no bar until the next load.
		// Left out of the server build: while the server can reach the bar, SvelteKit links its
		// CSS into every app page. On the client its CSS arrives with it, before it mounts.
		const load = () =>
			void (
				import.meta.env.SSR
					? Promise.reject(new Error('client only'))
					: import('./ResumeBar.svelte')
			).then(
				(m) => (ResumeBar = m.default),
				() => {}
			);
		if ('requestIdleCallback' in window) requestIdleCallback(load, { timeout: 3000 });
		else afterPaint(load);
	});
</script>

<div class="shell">
	<AppNav items={APP_NAV} profile={PROFILE} pathname={activePath(pathname, navigating.to?.url)} />
	<main id="main" class="content" tabindex="-1">
		<div class="notice-region" role="status">
			{#if !connectivity.online && !hideOfflineNotice}
				<p class="offline-notice" data-testid="offline-notice">
					Offline. Your sets are saved on this device.
				</p>
			{/if}
		</div>
		{@render children()}
	</main>
	{@render held?.()}
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

	/* From 1024 px: centred in the room right of the rail, but never more than
	   --column-offset-max from it, so a readable screen's text starts 200 px from the rail (Paper,
	   11 · Desktop). 100% is this content box: no 100vw, so no scrollbar error. */
	@media (width >= 64rem) {
		.content {
			margin-left: clamp(
				0px,
				(100% - var(--main-max, var(--content-column))) / 2,
				var(--column-offset-max)
			);
			margin-right: auto;
		}
	}

	/* One quiet line (Paper, 10 · States, "No signal"): nothing else on the screen changes. */
	.offline-notice {
		margin-top: var(--space-3);
		font: var(--type-secondary);
		color: var(--color-text-tertiary);
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
