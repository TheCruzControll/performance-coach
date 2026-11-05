<!--
  @component
  The Security screen's sheets — rename or remove a passkey, create new recovery codes and show
  them once. Interaction-only UI: the screen imports this on first intent (pointerdown) or tap,
  so it never weighs on the screen's initial JavaScript.
-->
<script lang="ts" module>
	export interface PasskeyTarget {
		id: string;
		nickname: string;
	}

	export type SheetRequest =
		| { kind: 'rename'; passkey: PasskeyTarget }
		| { kind: 'remove'; passkey: PasskeyTarget }
		| { kind: 'regenerate' };
</script>

<script lang="ts">
	import { enhance, type SubmitFunction } from '$app/forms';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import Button from '#lib/ui/components/Button.svelte';
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

	$effect(() => {
		const next = request;
		if (!next) return;
		if (next.kind === 'rename' || next.kind === 'remove') target = next.passkey;
		if (next.kind === 'rename') {
			nickname = next.passkey.nickname;
			renameOpen = true;
		} else if (next.kind === 'remove') removeOpen = true;
		else regenerateOpen = true;
	});

	function closed() {
		request = null;
	}

	/** Shared `use:enhance` handler: toast the outcome, refresh the screen, close the sheet. */
	function submit(message: string, close: () => void): SubmitFunction {
		return () => {
			pending = true;
			return async ({ result, update }) => {
				pending = false;
				if (result.type === 'success') {
					toast.show(message, { tone: 'positive' });
					close();
				} else if (result.type === 'failure') {
					toast.show(String(result.data?.error ?? 'That didn’t work. Try again.'), {
						tone: 'danger'
					});
				}
				await update({ reset: false });
			};
		};
	}

	const regenerate: SubmitFunction = () => {
		pending = true;
		return async ({ result, update }) => {
			pending = false;
			if (result.type === 'success' && Array.isArray(result.data?.codes)) {
				codes = result.data.codes as string[];
				acknowledged = false;
				regenerateOpen = false;
				codesOpen = true;
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

<style>
	.sheet-form {
		display: grid;
		gap: var(--space-3);
		padding-bottom: var(--space-2);
	}
</style>
