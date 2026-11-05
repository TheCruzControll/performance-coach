<!--
  @component
  The designed failure states: offline / unreachable, not found, and unexpected errors.
  Inside the app shell it keeps the screen's title so the user knows where they are; outside
  it (e.g. an unknown URL) it stands alone with the status code.
-->
<script lang="ts" module>
	export type ErrorKind = 'offline' | 'not-found' | 'error';

	export function errorKind(status: number, error: App.Error | null): ErrorKind {
		if (error?.offline) return 'offline';
		return status === 404 ? 'not-found' : 'error';
	}
</script>

<script lang="ts">
	import { onMount } from 'svelte';
	import { resolve } from '$app/paths';
	import { OFFLINE_PATH, startOfflineRecovery } from '#lib/client/recovery.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';

	interface Props {
		kind: ErrorKind;
		status?: number;
		message?: string;
		requestId?: string;
		/** Tab name for the URL (e.g. "Profile") when rendered inside the app shell. */
		screen?: string;
		inShell?: boolean;
	}

	let { kind, status, message, requestId, screen, inShell = false }: Props = $props();

	const title = $derived(
		kind === 'offline' ? 'Offline' : kind === 'not-found' ? 'Not found' : 'Error'
	);

	// "Offline" can mean no network at all, or a network that can't reach the server (lie-fi,
	// captive portal, outage) while navigator.onLine still reads true. Say which once known; until
	// then (server render, the prerendered /offline document) assume the common case: no network.
	let deviceOnline: boolean | null = $state(null);
	const offlineTitle = $derived(deviceOnline ? "Can't reach the server" : "You're offline");
	const offlineDescription = $derived(
		deviceOnline
			? 'Your connection looks up, but the server is not answering. This screen keeps retrying and loads by itself when it can.'
			: "This screen needs a connection. It loads by itself as soon as you're back online."
	);

	onMount(() => {
		if (kind !== 'offline') return;
		return startOfflineRecovery({ onDeviceStatus: (online) => (deviceOnline = online) });
	});

	function tryAgain() {
		// The /offline document at its own URL is always this screen: go into the app instead.
		if (location.pathname === OFFLINE_PATH) location.assign(resolve('/(app)/today'));
		else location.reload();
	}
</script>

<svelte:head>
	<title>{title} · Performance Coach</title>
</svelte:head>

{#if inShell}
	<PageHeader
		title={kind === 'not-found' ? 'Not found' : (screen ?? title)}
		eyebrow={kind === 'offline' ? 'No connection' : `Error ${status ?? ''}`.trim()}
	/>
{/if}

<section class="error-view" class:in-shell={inShell} data-kind={kind} data-testid="error-view">
	{#if !inShell && kind !== 'offline' && status}
		<p class="code numeric" aria-hidden="true">{status}</p>
	{/if}

	{#if kind === 'offline'}
		<EmptyState
			icon="wifi-off"
			tone="neutral"
			title={offlineTitle}
			description={offlineDescription}
			data-testid="offline-state"
		>
			{#snippet actions()}
				<Button variant="secondary" icon="refresh" onclick={tryAgain}>Try again</Button>
			{/snippet}
		</EmptyState>
	{:else if kind === 'not-found'}
		<EmptyState
			icon="target"
			tone="neutral"
			title="Nothing here"
			description="This page does not exist. Your training data is safe."
		>
			{#snippet actions()}
				<Button href={resolve('/(app)/today')} icon="today">Back to Today</Button>
			{/snippet}
		</EmptyState>
	{:else}
		<EmptyState
			icon="alert"
			tone="combat"
			title="Something went wrong"
			description={message ?? 'An unexpected error occurred.'}
		>
			{#snippet actions()}
				<Button variant="secondary" icon="refresh" onclick={() => location.reload()}>
					Try again
				</Button>
				{#if !inShell}
					<Button href={resolve('/(app)/today')} icon="today">Back to Today</Button>
				{/if}
			{/snippet}
		</EmptyState>
	{/if}

	{#if requestId}
		<p class="ref">Reference <code>{requestId}</code></p>
	{/if}
</section>

<style>
	.error-view {
		display: grid;
		place-content: center;
		justify-items: center;
		gap: var(--space-2);
		min-height: 100dvh;
		padding: calc(var(--safe-top) + var(--space-8)) var(--gutter)
			calc(var(--safe-bottom) + var(--space-8));
		text-align: center;
	}

	/* Inside the shell: centred in the space between the header and the tab bar. */
	.error-view.in-shell {
		min-height: auto;
		padding: var(--space-6) 0 var(--space-4);
	}

	.code {
		font-size: var(--text-6xl);
		font-weight: var(--weight-black);
		line-height: 1;
		color: var(--color-text-disabled);
	}

	.ref {
		font-size: var(--text-xs);
		color: var(--color-text-tertiary);
	}

	code {
		font-variant-numeric: tabular-nums;
	}
</style>
