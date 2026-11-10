<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import {
		cancelPendingPasskeyRequest,
		passkeySupport,
		PasskeyError,
		signInWithPasskey
	} from '#lib/client/passkeys.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import AuthScreen from './AuthScreen.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let busy = $state(false);
	let error = $state<string | null>(null);
	let unsupported = $state(false);
	/** Unsynced workout changes a signed-out URL without sign-out's marker kept on this device. */
	let kept = $state(0);
	const keptChanges = $derived(
		kept === 1
			? '1 workout change that hasn’t synced'
			: `${kept} workout changes that haven’t synced`
	);
	const them = $derived(kept === 1 ? 'it' : 'them');

	async function finish(redirectTo: string) {
		// A same-origin path the server already vetted (safeReturnPath), e.g. /today or ?next=.
		// eslint-disable-next-line svelte/no-navigation-without-resolve
		await goto(redirectTo, { replaceState: true, invalidateAll: true });
	}

	function explain(err: unknown) {
		if (err instanceof PasskeyError && err.kind === 'unsupported') unsupported = true;
		error = err instanceof PasskeyError ? err.message : 'Something went wrong. Try again.';
	}

	async function signIn() {
		if (busy) return;
		busy = true;
		error = null;
		try {
			const { redirectTo } = await signInWithPasskey({ next: data.next });
			await finish(redirectTo);
		} catch (err) {
			explain(err);
			busy = false;
		}
	}

	async function deleteKept() {
		const { clearDeviceAccountData } = await import('#lib/client/signout.ts');
		await clearDeviceAccountData();
		kept = 0;
	}

	onMount(() => {
		let active = true;
		void (async () => {
			if (data.signedOut) {
				// Also covers a sign-out submitted without JavaScript, which keeps unsynced changes.
				try {
					const { clearAfterSignedOutUrl } = await import('#lib/client/signout.ts');
					kept = (await clearAfterSignedOutUrl()).kept;
				} catch {
					// the chunk did not load: nothing was deleted
				}
			}
			if (data.unavailable) return;
			const support = await passkeySupport();
			if (!support.webauthn) {
				unsupported = true;
				return;
			}
			if (!support.autofill || !active) return;
			// Conditional UI: the browser offers the passkey in the field's autofill; a tap on the
			// button aborts this quiet request and starts a modal one.
			try {
				const { redirectTo } = await signInWithPasskey({ next: data.next, autofill: true });
				if (active) await finish(redirectTo);
			} catch (err) {
				// Autofill is a quiet extra: a browser that cannot run it (or the owner dismissing
				// it) is not an error. Only a passkey the server refused after it was picked is.
				if (active && !busy && err instanceof PasskeyError && err.stage === 'server') {
					explain(err);
				}
			}
		})();
		return () => {
			active = false;
			void cancelPendingPasskeyRequest();
		};
	});
</script>

<svelte:head>
	<title>Sign in · Performance Coach</title>
</svelte:head>

<AuthScreen
	eyebrow="Private performance coaching"
	title="Train with intent."
	lede="An AI coach that plans, adapts and explains — built on every set, run and round you log."
	data-testid="signin-screen"
>
	{#snippet body()}
		{#if data.signedOut && kept > 0}
			<Notice tone="warning" data-testid="signed-out-kept">
				This device still holds {keptChanges}. Sign in to send {them}, or delete {them}.
			</Notice>
			<div>
				<Button size="sm" variant="danger" onclick={deleteKept} data-testid="delete-kept">
					Delete {them}
				</Button>
			</div>
		{:else if data.signedOut && !error}
			<Notice tone="positive" icon="shield" data-testid="signed-out-notice">
				Signed out. This device no longer holds your account data.
			</Notice>
		{/if}
	{/snippet}

	<form
		class="signin"
		onsubmit={(event) => {
			event.preventDefault();
			void signIn();
		}}
	>
		<!-- Conditional UI anchor: Safari and Chrome offer saved passkeys in this field's autofill. -->
		<label class="account">
			<span class="visually-hidden">Account</span>
			<input
				name="username"
				autocomplete="username webauthn"
				placeholder="Choose a saved passkey"
				autocapitalize="none"
				spellcheck="false"
				readonly={busy}
				data-testid="passkey-field"
			/>
		</label>

		{#if data.unavailable}
			<Notice tone="warning" title="Passkeys aren’t available on this address">
				{data.unavailable.reason}
				{#if data.unavailable.signInUrl}
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- external origin -->
					<a href={data.unavailable.signInUrl}>Open {new URL(data.unavailable.signInUrl).host}</a>
				{/if}
			</Notice>
		{:else if unsupported}
			<Notice tone="warning" title="This browser can’t use passkeys">
				Open the app in Safari on your iPhone, or sign in with a recovery code.
			</Notice>
		{:else if error}
			<Notice tone="danger" data-testid="signin-error">{error}</Notice>
		{/if}

		<Button
			type="submit"
			size="lg"
			block
			icon="passkey"
			loading={busy}
			disabled={Boolean(data.unavailable) || unsupported}
			data-testid="passkey-signin"
		>
			{busy ? 'Waiting for your passkey…' : 'Sign in with passkey'}
		</Button>
	</form>

	<Button
		size="md"
		block
		variant="ghost"
		href={resolve('/recover')}
		data-testid="use-recovery-code"
	>
		Lost your passkey? Use a recovery code
	</Button>

	{#snippet footer()}
		<p>Private · Single owner · Passkeys only</p>
	{/snippet}
</AuthScreen>

<style>
	.signin {
		display: grid;
		gap: var(--space-3);
	}

	.account input {
		width: 100%;
		min-height: 3.25rem;
		padding: 0 var(--space-4);
		border-radius: var(--radius-full);
		border: 1px solid var(--color-border);
		background: color-mix(in srgb, var(--color-surface-2) 80%, transparent);
		color: var(--color-text);
		font: inherit;
		font-size: max(1rem, var(--text-base));
		text-align: center;
	}

	.account input::placeholder {
		color: var(--color-text-tertiary);
	}

	.account input:focus-visible {
		outline: none;
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-ring);
	}
</style>
