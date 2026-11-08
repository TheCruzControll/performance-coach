<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import Button from '#lib/ui/components/Button.svelte';
	import TextField from '#lib/ui/components/TextField.svelte';
	import AuthScreen from '../AuthScreen.svelte';
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();

	let code = $state('');
	let busy = $state(false);
</script>

<svelte:head>
	<title>Recovery · Performance Coach</title>
</svelte:head>

<AuthScreen
	eyebrow="Account recovery"
	title="Lost your passkey?"
	lede="Use one of your recovery codes. Each works once; next you’ll create a new passkey for this device."
	data-testid="recover-screen"
>
	<form
		method="POST"
		class="recover"
		use:enhance={() => {
			busy = true;
			return async ({ update }) => {
				await update({ reset: false });
				busy = false;
			};
		}}
	>
		<TextField
			label="Recovery code"
			name="code"
			bind:value={code}
			mono
			placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
			autocomplete="one-time-code"
			autocapitalize="characters"
			spellcheck={false}
			enterkeyhint="go"
			maxlength={40}
			required
			error={form?.error ?? null}
			hint="24 letters and numbers (16 in an older code); dashes and spaces are optional."
			data-testid="recovery-code-input"
		/>
		<Button
			type="submit"
			size="lg"
			block
			icon="shield"
			loading={busy}
			data-testid="recovery-submit"
		>
			Continue
		</Button>
	</form>

	<Button size="md" block variant="ghost" icon="chevron-left" href={resolve('/')}>
		Back to sign in
	</Button>

	{#snippet footer()}
		<p>No codes left? Ask the tech lead to reset the account (docs/deployment.md).</p>
	{/snippet}
</AuthScreen>

<style>
	.recover {
		display: grid;
		gap: var(--space-4);
	}
</style>
