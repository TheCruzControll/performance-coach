<!--
  @component
  The app shell: safe-area-aware content column, fixed bottom navigation and a connectivity
  notice. Used by the (app) layout and by the root error page for app URLs, so a screen that
  fails to load (e.g. offline) never strands the user without navigation.
-->
<script lang="ts">
	import { onMount, type Snippet } from 'svelte';
	import { connectivity } from '#lib/client/connectivity.svelte.ts';
	import BottomNav from '#lib/ui/components/BottomNav.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import { APP_NAV } from './nav';

	interface Props {
		pathname: string;
		/** The screen is itself an offline/error state: no separate offline notice. */
		hideOfflineNotice?: boolean;
		children: Snippet;
	}

	let { pathname, hideOfflineNotice = false, children }: Props = $props();

	onMount(() => connectivity.start());
</script>

<div class="shell">
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
	<BottomNav items={APP_NAV} {pathname} />
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
