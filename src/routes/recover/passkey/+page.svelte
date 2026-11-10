<script lang="ts">
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { addPasskey, PasskeyError } from '#lib/client/passkeys.ts';
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

	// Cancel signs out. Workout changes not synced yet are flushed first (this session's sync is
	// refused at once, as it is not a full session) and the owner is asked before signing out
	// deletes them (the offline workout sync ADR). Sign-out, the check and its sheet load on intent.
	let leaving = $state(false);
	const pendingSheet = () => import('#lib/ui/components/SignOutPendingSheet.svelte');
	let sheet = $state<ReturnType<typeof pendingSheet> | null>(null);
	let asking = $state(false);
	let unsynced = $state(0);

	function loadSheet() {
		// A chunk that failed to load (offline) is fetched again on the next try.
		sheet ??= pendingSheet().catch((error: unknown) => {
			sheet = null;
			throw error;
		});
		return sheet;
	}

	async function cancel() {
		if (leaving) return;
		leaving = true;
		try {
			const { unsyncedAfterFlush } = await import('#lib/client/workout/shutdown.ts');
			const left = await unsyncedAfterFlush();
			if (left > 0) {
				await loadSheet();
				unsynced = left;
				asking = true;
				leaving = false;
				return;
			}
			await signOutNow();
		} catch {
			failed();
		}
	}

	/** "Sign out and delete", unless more changes arrived since it asked: then it asks again. */
	async function deleteAndLeave() {
		if (leaving) return;
		leaving = true;
		try {
			const { pendingCount } = await import('#lib/client/workout/probe.ts');
			const pending = await pendingCount();
			if (pending > unsynced) {
				unsynced = pending;
				leaving = false;
				return;
			}
			asking = false;
			await signOutNow();
		} catch {
			failed();
		}
	}

	async function signOutNow() {
		const { signOut } = await import('#lib/client/signout.ts');
		await signOut();
	}

	function failed() {
		leaving = false;
		toast.show('Can’t reach the server to sign out.', { tone: 'danger' });
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
		loading={leaving}
		onclick={cancel}
		data-testid="recover-cancel"
	>
		Cancel and sign out
	</Button>

	{#snippet footer()}
		<p>This recovery session ends 15 minutes after the code was used.</p>
	{/snippet}
</AuthScreen>

{#if sheet}
	{#await sheet then { default: SignOutPendingSheet }}
		<SignOutPendingSheet bind:open={asking} count={unsynced} onconfirm={deleteAndLeave} />
	{/await}
{/if}
