<script lang="ts">
	import { onMount } from 'svelte';
	import { beforeNavigate, goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { createFirstPasskey, PasskeyError, passkeySupport } from '#lib/client/passkeys.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import RecoveryCodes from '#lib/ui/components/RecoveryCodes.svelte';
	import TextField from '#lib/ui/components/TextField.svelte';
	import AuthScreen from '../AuthScreen.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let name = $state('');
	let nameError = $state<string | null>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let unsupported = $state(false);
	let codes = $state<string[] | null>(null);
	let acknowledged = $state(false);

	onMount(() => {
		void passkeySupport().then((s) => (unsupported = !s.webauthn));
	});

	// The codes exist only on this screen: confirm before leaving without saving them.
	const unsaved = $derived(codes !== null && !acknowledged);
	beforeNavigate(({ cancel, willUnload }) => {
		if (unsaved && !willUnload && !confirm('Leave without saving your recovery codes?')) cancel();
	});
	$effect(() => {
		if (!unsaved) return;
		const warn = (event: BeforeUnloadEvent) => event.preventDefault();
		addEventListener('beforeunload', warn);
		return () => removeEventListener('beforeunload', warn);
	});

	async function create() {
		if (busy) return;
		nameError = name.trim() ? null : 'Enter your name.';
		if (nameError) return;
		busy = true;
		error = null;
		try {
			const token = page.url.searchParams.get('token') ?? '';
			const result = await createFirstPasskey({ token, name: name.trim() });
			codes = result.recoveryCodes;
		} catch (err) {
			if (err instanceof PasskeyError && err.kind === 'unsupported') unsupported = true;
			error = err instanceof PasskeyError ? err.message : 'Something went wrong. Try again.';
		} finally {
			busy = false;
		}
	}

	async function done() {
		await goto(resolve('/(app)/today'), { replaceState: true, invalidateAll: true });
	}
</script>

<svelte:head>
	<title>Set up · Performance Coach</title>
</svelte:head>

{#if codes}
	<AuthScreen
		eyebrow="Step 2 of 2 · Recovery"
		title="Keep these safe."
		lede="If you ever lose every passkey, one of these codes signs you in once. This is the only time they’re shown."
		data-testid="setup-codes"
	>
		<RecoveryCodes {codes} bind:acknowledged />
		<Button
			size="lg"
			block
			iconEnd="arrow-right"
			disabled={!acknowledged}
			onclick={done}
			data-testid="setup-done"
		>
			Continue to the app
		</Button>
	</AuthScreen>
{:else}
	<AuthScreen
		eyebrow="Step 1 of 2 · First-run setup"
		title="Make it yours."
		lede="Create the passkey that unlocks your coach. It stays on your devices — no password to remember, nothing to phish."
		data-testid="setup-screen"
	>
		{#snippet body()}
			<ul class="facts">
				<li><Icon name="passkey" size={18} /> Face ID or Touch ID each time you sign in</li>
				<li><Icon name="lock" size={18} /> Only you can sign in. There is no sign-up.</li>
				<li><Icon name="shield" size={18} /> 10 recovery codes as a backup, shown next</li>
			</ul>
		{/snippet}

		<form
			class="setup"
			onsubmit={(event) => {
				event.preventDefault();
				void create();
			}}
		>
			<TextField
				label="Your name"
				bind:value={name}
				autocomplete="name"
				autocapitalize="words"
				enterkeyhint="go"
				maxlength={64}
				error={nameError}
				hint="Shown on your passkey and in the app."
				data-testid="owner-name"
			/>

			{#if data.unavailable}
				<Notice tone="warning" title="Passkeys aren’t available on this address">
					{data.unavailable}
				</Notice>
			{:else if unsupported}
				<Notice tone="warning" title="This browser can’t create passkeys">
					Open this link in Safari on your iPhone.
				</Notice>
			{:else if error}
				<Notice tone="danger" data-testid="setup-error">{error}</Notice>
			{/if}

			<Button
				type="submit"
				size="lg"
				block
				icon="passkey"
				loading={busy}
				disabled={Boolean(data.unavailable) || unsupported}
				data-testid="create-passkey"
			>
				{busy ? 'Waiting for your passkey…' : 'Create passkey'}
			</Button>
		</form>
	</AuthScreen>
{/if}

<style>
	.facts {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.facts li {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.facts :global(.icon) {
		flex: none;
		color: var(--color-accent-text);
	}

	.setup {
		display: grid;
		gap: var(--space-4);
	}
</style>
