<!--
  @component
  The Security screen's sheets — rename or remove a passkey, create new recovery codes and show
  them once, and confirm it's the owner with a passkey when the server asks for it (step-up)
  before retrying the action. Interaction-only UI: the screen imports this on first intent
  (pointerdown) or tap, so it never weighs on the screen's initial JavaScript.
-->
<script lang="ts" module>
	export interface PasskeyTarget {
		id: string;
		nickname: string;
	}

	export type SheetRequest =
		| { kind: 'rename'; passkey: PasskeyTarget }
		| { kind: 'remove'; passkey: PasskeyTarget }
		| { kind: 'regenerate' }
		/** The server answered `reauth_required`: confirm with a passkey, then `retry`. */
		| { kind: 'reauth'; retry: () => void };
</script>

<script lang="ts">
	import { enhance, type ActionResult, type SubmitFunction } from '$app/forms';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import RecoveryCodes from '#lib/ui/components/RecoveryCodes.svelte';
	import TextField from '#lib/ui/components/TextField.svelte';
	import { toast } from '#lib/ui/toast.svelte.ts';

	interface Props {
		/** The sheet to show; set to null when it closes. */
		request: SheetRequest | null;
	}

	let { request = $bindable() }: Props = $props();

	// Each sheet keeps its target while it animates out after `request` is cleared.
	let target = $state<PasskeyTarget | null>(null);
	let nickname = $state('');
	let renameOpen = $state(false);
	let removeOpen = $state(false);
	let regenerateOpen = $state(false);
	let codesOpen = $state(false);
	let codes = $state<string[]>([]);
	let acknowledged = $state(false);
	let pending = $state(false);
	let reauthOpen = $state(false);
	let reauthError = $state<string | null>(null);
	let verifying = $state(false);
	let retry: (() => void) | null = null;

	$effect(() => {
		const next = request;
		if (!next) return;
		if (next.kind === 'rename' || next.kind === 'remove') target = next.passkey;
		if (next.kind === 'rename') {
			nickname = next.passkey.nickname;
			renameOpen = true;
		} else if (next.kind === 'remove') removeOpen = true;
		else if (next.kind === 'regenerate') regenerateOpen = true;
		else confirm(next.retry);
	});

	function closed() {
		request = null;
	}

	// ---- step-up: over the sheet that asked (or on its own), then retry the action ----------
	function confirm(action: () => void) {
		retry = action;
		reauthError = null;
		reauthOpen = true;
	}

	function reauthClosed() {
		// Dismissed (Cancel, Escape, swipe) before confirming: the refused action never ran.
		if (retry) toast.show('Nothing was changed.', { tone: 'neutral' });
		retry = null;
		if (request?.kind === 'reauth') closed();
	}

	async function verify() {
		verifying = true;
		reauthError = null;
		try {
			const { reauthenticate, PasskeyError } = await import('#lib/client/passkeys.ts');
			try {
				await reauthenticate();
			} catch (err) {
				reauthError =
					err instanceof PasskeyError ? err.message : 'Something went wrong. Try again.';
				return;
			}
			const action = retry;
			retry = null;
			reauthOpen = false;
			reauthClosed();
			action?.();
		} finally {
			verifying = false;
		}
	}

	const needsPasskey = (result: ActionResult) =>
		result.type === 'failure' && result.data?.code === 'reauth_required';

	/** Shared `use:enhance` handler: toast the outcome, refresh the screen, close the sheet. */
	function submit(message: string, close: () => void): SubmitFunction {
		return ({ formElement }) => {
			pending = true;
			return async ({ result, update }) => {
				pending = false;
				if (result.type === 'success') {
					toast.show(message, { tone: 'positive' });
					close();
				} else if (needsPasskey(result)) {
					confirm(() => formElement.requestSubmit());
				} else if (result.type === 'failure') {
					toast.show(String(result.data?.error ?? 'That didn’t work. Try again.'), {
						tone: 'danger'
					});
				}
				await update({ reset: false });
			};
		};
	}

	const regenerate: SubmitFunction = ({ formElement }) => {
		pending = true;
		return async ({ result, update }) => {
			pending = false;
			if (result.type === 'success' && Array.isArray(result.data?.codes)) {
				codes = result.data.codes as string[];
				acknowledged = false;
				regenerateOpen = false;
				codesOpen = true;
			} else if (needsPasskey(result)) {
				confirm(() => formElement.requestSubmit());
			} else {
				toast.show('Couldn’t create new codes. Try again.', { tone: 'danger' });
			}
			await update({ reset: false });
		};
	};

	function codesClosed() {
		if (!acknowledged) {
			toast.show('Your new codes are active. If you didn’t save them, create another set.', {
				tone: 'danger',
				duration: 6000
			});
		}
		codes = [];
		closed();
	}
</script>

<BottomSheet
	bind:open={renameOpen}
	title="Rename passkey"
	onclose={closed}
	data-testid="rename-sheet"
>
	<form
		method="POST"
		action="?/rename"
		class="sheet-form"
		use:enhance={submit('Passkey renamed', () => {
			renameOpen = false;
			closed();
		})}
	>
		<input type="hidden" name="id" value={target?.id ?? ''} />
		<TextField
			label="Name"
			name="nickname"
			bind:value={nickname}
			maxlength={64}
			required
			hint="For example “iPhone 15 Pro” or “YubiKey”."
			data-testid="passkey-nickname"
		/>
		<Button type="submit" block loading={pending} data-testid="save-nickname">Save</Button>
	</form>
</BottomSheet>

<BottomSheet
	bind:open={removeOpen}
	title="Remove {target?.nickname ?? 'passkey'}?"
	description="You won’t be able to sign in with it any more. Devices that signed in with it are signed out."
	onclose={closed}
	data-testid="remove-sheet"
>
	<form
		method="POST"
		action="?/remove"
		class="sheet-form"
		use:enhance={submit('Passkey removed', () => {
			removeOpen = false;
			closed();
		})}
	>
		<input type="hidden" name="id" value={target?.id ?? ''} />
		<Button
			type="submit"
			variant="danger"
			block
			icon="trash"
			loading={pending}
			data-testid="confirm-remove"
		>
			Remove passkey
		</Button>
		<Button
			variant="ghost"
			block
			onclick={() => {
				removeOpen = false;
				closed();
			}}
		>
			Keep it
		</Button>
	</form>
</BottomSheet>

<BottomSheet
	bind:open={regenerateOpen}
	title="Create new recovery codes?"
	description="Your current codes stop working immediately. You’ll see the new ones once."
	onclose={() => {
		if (!codesOpen) closed();
	}}
	data-testid="regenerate-sheet"
>
	<form method="POST" action="?/regenerate" class="sheet-form" use:enhance={regenerate}>
		<Button type="submit" block icon="refresh" loading={pending} data-testid="confirm-regenerate">
			Create new codes
		</Button>
		<Button
			variant="ghost"
			block
			onclick={() => {
				regenerateOpen = false;
				closed();
			}}
		>
			Cancel
		</Button>
	</form>
</BottomSheet>

<BottomSheet
	bind:open={codesOpen}
	title="Your new recovery codes"
	description="Save them now: this is the only time they’re shown."
	onclose={codesClosed}
	data-testid="codes-sheet"
>
	<div class="sheet-form">
		<RecoveryCodes {codes} bind:acknowledged data-testid="new-codes" />
		<Button
			block
			disabled={!acknowledged}
			onclick={() => {
				codesOpen = false;
				codesClosed();
			}}
			data-testid="codes-done"
		>
			Done
		</Button>
	</div>
</BottomSheet>

<BottomSheet
	bind:open={reauthOpen}
	title="Confirm it’s you"
	description="Changes to passkeys, recovery codes and signed-in devices need one of your passkeys. You won’t be asked again for 5 minutes."
	onclose={reauthClosed}
	data-testid="reauth-sheet"
>
	<div class="sheet-form">
		{#if reauthError}
			<Notice tone="danger" title="Nothing was changed" data-testid="reauth-error">
				{reauthError}
			</Notice>
		{/if}
		<Button block icon="passkey" loading={verifying} onclick={verify} data-testid="reauth-continue">
			Continue with passkey
		</Button>
		<Button
			variant="ghost"
			block
			onclick={() => {
				reauthOpen = false;
				reauthClosed();
			}}
		>
			Cancel
		</Button>
	</div>
</BottomSheet>

<style>
	.sheet-form {
		display: grid;
		gap: var(--space-3);
		padding-bottom: var(--space-2);
	}
</style>
