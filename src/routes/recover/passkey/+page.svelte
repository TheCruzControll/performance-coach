<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { addPasskey, PasskeyError } from '#lib/client/passkeys.ts';
	import { signOut } from '#lib/client/signout.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import { toast } from '#lib/ui/toast.svelte.ts';
	import AuthScreen from '../../AuthScreen.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let busy = $state(false);
	let error = $state<string | null>(null);

	async function create() {
		if (busy) return;
		busy = true;
		error = null;
		try {
			await addPasskey();
			// eslint-disable-next-line svelte/no-navigation-without-resolve -- resolve() + a query
			await goto(`${resolve('/(app)/profile/security')}?recovered=1`, {
				replaceState: true,
				invalidateAll: true
			});
		} catch (err) {
			error = err instanceof PasskeyError ? err.message : 'Something went wrong. Try again.';
			busy = false;
		}
	}

	async function cancel() {
		try {
			await signOut();
		} catch {
			toast.show('Can’t reach the server to sign out.', { tone: 'danger' });
		}
	}
</script>

<svelte:head>
	<title>New passkey · Performance Coach</title>
</svelte:head>

<AuthScreen
	eyebrow="Recovery · One step left"
	title="New passkey, {data.name.split(' ')[0]}."
	lede="You’re in with a recovery code. Create a passkey for this device to unlock the app — until then everything else stays locked."
	data-testid="recover-passkey-screen"
>
	{#snippet body()}
		<Notice
			tone={data.remaining <= 3 ? 'warning' : 'neutral'}
			icon="shield"
			data-testid="codes-left"
		>
			{data.remaining}
			{data.remaining === 1 ? 'recovery code' : 'recovery codes'} left.
			{#if data.remaining <= 3}Create a fresh set in Security once you’re back in.{/if}
		</Notice>
	{/snippet}

	{#if data.unavailable}
		<Notice tone="warning" title="Passkeys aren’t available on this address">
			{data.unavailable}
		</Notice>
	{:else if error}
		<Notice tone="danger" data-testid="recover-error">{error}</Notice>
	{/if}

	<Button
		size="lg"
		block
		icon="passkey"
		loading={busy}
		disabled={Boolean(data.unavailable)}
		onclick={create}
		data-testid="create-recovery-passkey"
	>
		{busy ? 'Waiting for your passkey…' : 'Create passkey'}
	</Button>
	<Button
		size="md"
		block
		variant="ghost"
		icon="sign-out"
		onclick={cancel}
		data-testid="recover-cancel"
	>
		Cancel and sign out
	</Button>

	{#snippet footer()}
		<p>This recovery session ends 15 minutes after the code was used.</p>
	{/snippet}
</AuthScreen>
