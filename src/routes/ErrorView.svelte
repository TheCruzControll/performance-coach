<!--
  @component
  The designed failure states (Paper, 10 · States): offline or unreachable, not found, and an
  unexpected error. Each says one thing and offers at most one thing to do (error-copy.ts). Inside
  the app shell the state sits at the foot of the column, above the tab bar, in the thumb zone;
  outside it (an unknown URL) it is centred in the window. On Today it keeps the avatar, so Profile
  stays one tap away on a phone; offline at the start URL (and /offline) Today keeps its title, one
  quiet line, and the sessions saved on this device (OfflineToday.svelte).
-->
<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { afterNavigate, beforeNavigate, onNavigate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import {
		OFFLINE_PATH,
		reloadFresh,
		startOfflineRecovery,
		trackPress
	} from '#lib/client/recovery.ts';
	import { listsToday } from '#lib/client/workout/launch.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import { errorCopy, offlineLine, type ErrorKind } from './error-copy.ts';

	interface Props {
		kind: ErrorKind;
		requestId?: string;
		/** The screen at this URL (e.g. "Profile") when rendered inside the app shell. */
		screen?: string;
		inShell?: boolean;
	}

	let { kind, requestId, screen, inShell = false }: Props = $props();

	const documentTitle = $derived(
		kind === 'offline' ? 'Offline' : kind === 'not-found' ? 'Not found' : 'Error'
	);

	// "Offline" can mean no network at all, or a network that can't reach the server (lie-fi,
	// captive portal, outage) while navigator.onLine still reads true. Say which once known; until
	// then (server render, the prerendered /offline document) assume the common case: no network.
	let deviceOnline: boolean | null = $state(null);

	const copy = $derived(
		errorCopy(kind, { screen, deviceOnline, atOfflinePath: page.url.pathname === OFFLINE_PATH })
	);
	/** Offline at the start URL or /offline: Today's title, a quiet line, today's saved sessions. */
	const todayOffline = $derived(kind === 'offline' && inShell && listsToday(page.url.pathname));
	/** Profile's way in on a phone is Today's avatar: the state keeps it (known-issues, v2/03a). */
	const avatar = $derived(inShell && screen === 'Today');

	// Recovery belongs to the screen at this URL: a navigation the user starts stops it, so its
	// reload cannot pull them back here, and the view (reused across error URLs) starts it again.
	// The same holds for a pending "Try again".
	let stopRecovery: (() => void) | undefined;
	let cancelTryAgain: (() => void) | undefined;
	afterNavigate(() => {
		stopRecovery?.();
		stopRecovery =
			kind === 'offline'
				? startOfflineRecovery({ onDeviceStatus: (online) => (deviceOnline = online) })
				: undefined;
	});
	beforeNavigate(({ willUnload }) => {
		if (willUnload) return;
		stopRecovery?.();
		cancelTryAgain?.();
	});
	onDestroy(() => {
		stopRecovery?.();
		cancelTryAgain?.();
	});

	// The screen that replaces this one (the recovery's, mostly) renders once a press under way
	// ends, so a tap begun here lands here: swapped out mid-press, it would fire no click.
	let press: ReturnType<typeof trackPress> | undefined;
	onMount(() => {
		press = trackPress();
		return () => press?.stop();
	});
	onNavigate(() => press?.released());

	function tryAgain() {
		if (kind !== 'offline') return location.reload();
		// The /offline document at its own URL is always this screen: go into the app instead.
		if (location.pathname === OFFLINE_PATH) location.assign(resolve('/(app)/today'));
		else {
			cancelTryAgain?.();
			cancelTryAgain = reloadFresh();
		}
	}
</script>

<svelte:head>
	<title>{documentTitle} · Performance Coach</title>
</svelte:head>

{#snippet profileLink()}
	<a
		class="avatar-link state-avatar"
		href={resolve('/(app)/profile')}
		aria-label="Profile"
		data-testid="today-avatar"><Icon name="profile" size={16} /></a
	>
{/snippet}

{#if todayOffline}
	<PageHeader title={screen ?? documentTitle} trailing={avatar ? profileLink : undefined} />
	<section class="error-view in-shell today" data-kind={kind} data-testid="error-view">
		<p class="quiet" data-testid="offline-state">{offlineLine(deviceOnline)}</p>
		{#if copy.action === 'try-again'}
			<Button variant="ghost" onclick={tryAgain}>Try again</Button>
		{/if}
	</section>
	<!-- A launch with no signal can still start today's sessions saved on this device. Loaded
	     only here, so no other screen's first load carries it; the service worker precaches it. -->
	{#await import('./OfflineToday.svelte') then { default: OfflineToday }}
		<OfflineToday />
	{/await}
{:else}
	{#if avatar}
		<div class="top">{@render profileLink()}</div>
	{/if}
	<section class="error-view" class:in-shell={inShell} data-kind={kind} data-testid="error-view">
		<div class="state" data-testid={kind === 'offline' ? 'offline-state' : undefined}>
			{#if copy.line}<p class="line">{copy.line}</p>{/if}
			<h1 class="title" class:display={kind === 'not-found'}>{copy.title}</h1>
			<p class="body">{copy.body}</p>
			{#if copy.action}
				<div class="action">
					{#if copy.action === 'back-to-today'}
						<Button variant="secondary" href={resolve('/(app)/today')} block>Back to Today</Button>
					{:else}
						<Button onclick={tryAgain} block>Try again</Button>
					{/if}
					{#if requestId}
						<p class="ref">Reference <span class="numeric">{requestId}</span></p>
					{/if}
				</div>
			{:else if requestId}
				<p class="ref">Reference <span class="numeric">{requestId}</span></p>
			{/if}
		</div>
	</section>
{/if}

<style>
	/* Outside the shell: centred in the window at the readable width. */
	.error-view {
		display: grid;
		place-content: center;
		min-height: 100dvh;
		width: min(100%, var(--content-readable));
		margin-inline: auto;
		padding: calc(var(--safe-top) + var(--space-8)) var(--gutter)
			calc(var(--safe-bottom) + var(--space-8));
	}

	/* In the shell: the column's foot, above the tab bar (Paper: 48 px over its hairline, the
	   shell's 32 px bottom padding plus 16). The top row, when there is one, is 44 px. */
	.error-view.in-shell {
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		width: auto;
		margin: 0;
		min-height: calc(
			100dvh - var(--safe-top) - var(--nav-inset-bottom) - var(--space-8) - var(--top-row, 0px)
		);
		padding: var(--space-6) 0 var(--space-4);
	}

	:global(:root:has(.state-avatar)) .error-view.in-shell {
		--top-row: calc(var(--touch-target) + var(--space-3));
	}

	/* Today offline: the quiet line under the title, then today's sessions; nothing anchored. */
	.error-view.in-shell.today {
		min-height: auto;
		padding: 0;
		justify-content: flex-start;
	}

	.top {
		display: flex;
		justify-content: flex-end;
		align-items: center;
		min-height: var(--touch-target);
		margin-top: var(--space-3);
	}

	.state {
		display: grid;
		justify-items: start;
	}

	.line {
		padding-bottom: var(--space-3);
		font: var(--type-secondary);
		color: var(--color-danger);
	}

	.title {
		font: var(--type-statement);
		letter-spacing: var(--tracking-statement);
		color: var(--color-text);
	}

	.title.display {
		font: var(--type-display);
		letter-spacing: var(--tracking-display-lg);
	}

	.body {
		padding-top: var(--space-4);
		font: var(--type-body);
		color: var(--color-text-secondary);
	}

	.action {
		display: grid;
		width: 100%;
		padding-top: var(--space-8);
	}

	.ref {
		padding-top: var(--space-5);
		font: var(--type-caption);
		color: var(--color-text-tertiary);
		text-align: center;
	}

	.quiet {
		margin-top: var(--space-2);
		font: var(--type-secondary);
		color: var(--color-text-tertiary);
	}

	@media (width >= 64rem) {
		.state-avatar,
		.top {
			display: none;
		}

		:global(:root:has(.state-avatar)) .error-view.in-shell {
			--top-row: 0px;
		}

		.error-view.in-shell {
			padding-bottom: var(--space-10);
		}

		.title {
			max-width: 32.5rem;
			font: var(--type-title);
			letter-spacing: var(--tracking-display);
		}

		/* Not found stays the display line at a desk (D8). */
		.title.display {
			font: var(--type-display);
			letter-spacing: var(--tracking-display-lg);
		}

		.action {
			width: 16.25rem;
		}
	}
</style>
