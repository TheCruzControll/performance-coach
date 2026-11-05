<script lang="ts">
	import type { SubmitFunction } from '$app/forms';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { addPasskey, PasskeyError } from '#lib/client/passkeys.ts';
	import { signOut } from '#lib/client/signout.ts';
	import Badge from '#lib/ui/components/Badge.svelte';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import IconButton from '#lib/ui/components/IconButton.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import RecoveryCodes from '#lib/ui/components/RecoveryCodes.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import Surface from '#lib/ui/components/Surface.svelte';
	import TextField from '#lib/ui/components/TextField.svelte';
	import { shortDate, timeAgo } from '#lib/ui/time.ts';
	import { toast } from '#lib/ui/toast.svelte.ts';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Passkey = (typeof data.passkeys)[number];

	const now = $derived(new Date(data.now));
	const others = $derived(data.sessions.filter((s) => !s.current).length);
	const onlyPasskey = $derived(data.passkeys.length <= 1);

	const METHOD: Record<string, string> = {
		setup: 'set up',
		passkey: 'passkey',
		recovery: 'recovery code',
		test: 'test session'
	};

	// ---- add ------------------------------------------------------------------------------
	let adding = $state(false);
	let addError = $state<string | null>(null);

	async function add() {
		if (adding) return;
		adding = true;
		addError = null;
		try {
			const { passkey } = await addPasskey();
			toast.show(`Passkey added: ${passkey.nickname}`, { tone: 'positive' });
			await invalidateAll();
		} catch (err) {
			addError = err instanceof PasskeyError ? err.message : 'Something went wrong. Try again.';
		} finally {
			adding = false;
		}
	}

	// ---- rename / remove -----------------------------------------------------------------
	let target = $state<Passkey | null>(null);
	let renameOpen = $state(false);
	let removeOpen = $state(false);
	let nickname = $state('');
	let pending = $state(false);

	function openRename(passkey: Passkey) {
		target = passkey;
		nickname = passkey.nickname;
		renameOpen = true;
	}

	function openRemove(passkey: Passkey) {
		target = passkey;
		removeOpen = true;
	}

	/** Shared `use:enhance` handler: toast the outcome, refresh the data, close the sheet. */
	function submit(success: (data: Record<string, unknown>) => string, close?: () => void) {
		return (() => {
			pending = true;
			return async ({ result, update }) => {
				pending = false;
				if (result.type === 'success') {
					toast.show(success(result.data ?? {}), { tone: 'positive' });
					close?.();
					await update({ reset: false });
				} else if (result.type === 'failure') {
					toast.show(String(result.data?.error ?? 'That didn’t work. Try again.'), {
						tone: 'danger'
					});
					await update({ reset: false });
				} else {
					await update();
				}
			};
		}) satisfies SubmitFunction;
	}

	// ---- recovery codes ------------------------------------------------------------------
	let regenerateOpen = $state(false);
	let codesOpen = $state(false);
	let freshCodes = $state<string[]>([]);
	let acknowledged = $state(false);

	const regenerate: SubmitFunction = () => {
		pending = true;
		return async ({ result, update }) => {
			pending = false;
			if (result.type === 'success' && Array.isArray(result.data?.codes)) {
				freshCodes = result.data.codes as string[];
				acknowledged = false;
				regenerateOpen = false;
				codesOpen = true;
				await update({ reset: false });
			} else {
				toast.show('Couldn’t create new codes. Try again.', { tone: 'danger' });
				await update({ reset: false });
			}
		};
	};

	function closeCodes() {
		if (!acknowledged) return;
		codesOpen = false;
		freshCodes = [];
	}

	// ---- sign out --------------------------------------------------------------------------
	let signingOut = $state(false);

	async function leave() {
		signingOut = true;
		try {
			await signOut();
		} catch {
			signingOut = false;
			toast.show('Can’t reach the server to sign out. Try again when you’re online.', {
				tone: 'danger'
			});
		}
	}
</script>

<svelte:head>
	<title>Security · Performance Coach</title>
</svelte:head>

<a class="back" href={resolve('/(app)/profile')}>
	<Icon name="chevron-left" size={18} /> Profile
</a>
<PageHeader title="Security" eyebrow="Passkeys & devices" />

<div class="stack">
	{#if data.recovered}
		<Notice tone="positive" title="You’re back in" data-testid="recovered-notice">
			Remove the passkey you lost and sign out any device you don’t recognise.
		</Notice>
	{/if}

	<Section title="Passkeys" gap="md">
		{#snippet action()}
			<Button
				size="sm"
				variant="secondary"
				icon="plus"
				loading={adding}
				onclick={add}
				data-testid="add-passkey"
			>
				Add passkey
			</Button>
		{/snippet}
		<Surface padding="none" radius="xl">
			<ul class="rows" data-testid="passkeys">
				{#each data.passkeys as passkey (passkey.id)}
					<li class="row" data-testid="passkey-row">
						<span class="glyph" aria-hidden="true"><Icon name="passkey" size={22} /></span>
						<div class="main">
							<p class="title" data-testid="passkey-name">{passkey.nickname}</p>
							<p class="meta">
								{passkey.provider ?? (passkey.synced ? 'Synced passkey' : 'This device only')}
								· Added {shortDate(passkey.createdAt, now)}
							</p>
							<p class="meta">
								{passkey.lastUsedAt
									? `Last used ${timeAgo(passkey.lastUsedAt, now)}`
									: 'Not used to sign in yet'}
							</p>
						</div>
						<div class="actions">
							<IconButton
								icon="pencil"
								label="Rename {passkey.nickname}"
								size="sm"
								onclick={() => openRename(passkey)}
								data-testid="rename-passkey"
							/>
							<IconButton
								icon="trash"
								label={onlyPasskey
									? `${passkey.nickname} is your only passkey`
									: `Remove ${passkey.nickname}`}
								size="sm"
								disabled={onlyPasskey}
								onclick={() => openRemove(passkey)}
								data-testid="remove-passkey"
							/>
						</div>
					</li>
				{/each}
			</ul>
		</Surface>
		{#if addError}
			<Notice tone="danger" data-testid="add-passkey-error">{addError}</Notice>
		{:else if onlyPasskey}
			<p class="note">
				Add a second passkey — on your Mac, or a security key — so losing one device never locks you
				out. Your only passkey can’t be removed.
			</p>
		{/if}
	</Section>

	<Section title="Signed-in devices" gap="md">
		{#snippet action()}
			{#if others > 0}
				<form
					method="POST"
					action="?/revokeOthers"
					use:enhance={submit(
						(d) => `Signed out ${d.count} other ${d.count === 1 ? 'device' : 'devices'}`
					)}
				>
					<Button
						type="submit"
						size="sm"
						variant="ghost"
						icon="sign-out"
						data-testid="revoke-others"
					>
						Sign out others
					</Button>
				</form>
			{/if}
		{/snippet}
		<Surface padding="none" radius="xl">
			<ul class="rows" data-testid="sessions">
				{#each data.sessions as s (s.id)}
					<li class="row" data-testid="session-row" data-current={s.current}>
						<span class="glyph" aria-hidden="true"><Icon name="device" size={22} /></span>
						<div class="main">
							<p class="title">
								{s.device}
								{#if s.current}<Badge tone="accent">This device</Badge>{/if}
							</p>
							<p class="meta">
								{s.current ? 'Active now' : `Active ${timeAgo(s.lastSeenAt, now)}`} · Signed in
								{shortDate(s.createdAt, now)} with {METHOD[s.method] ?? s.method}
							</p>
						</div>
						{#if !s.current}
							<form
								method="POST"
								action="?/revoke"
								use:enhance={submit(() => `Signed out ${s.device}`)}
							>
								<input type="hidden" name="id" value={s.id} />
								<Button
									type="submit"
									size="sm"
									variant="ghost"
									aria-label="Sign out {s.device}"
									data-testid="revoke-session"
								>
									Sign out
								</Button>
							</form>
						{/if}
					</li>
				{/each}
			</ul>
		</Surface>
	</Section>

	<Section title="Recovery codes" gap="md">
		<Surface padding="md" radius="xl">
			<div class="codes">
				<div class="codes-head">
					<p class="codes-count" data-testid="codes-remaining">
						<span class="numeric">{data.codes.unused}</span>
						<span class="of">of {data.codes.total} left</span>
					</p>
					{#if data.codes.unused <= 3}
						<Badge tone="warning" icon="alert">Running low</Badge>
					{/if}
				</div>
				<div
					class="meter"
					role="meter"
					aria-label="Recovery codes left"
					aria-valuemin={0}
					aria-valuemax={data.codes.total || 10}
					aria-valuenow={data.codes.unused}
				>
					{#each Array.from({ length: data.codes.total || 10 }, (_, i) => i) as i (i)}
						<span class="pip" class:on={i < data.codes.unused}></span>
					{/each}
				</div>
				<p class="note">
					Each code signs you in once if you lose every passkey. New codes replace all of these.
				</p>
				<Button
					variant="secondary"
					size="sm"
					icon="refresh"
					onclick={() => (regenerateOpen = true)}
					data-testid="regenerate-codes"
				>
					Create new codes
				</Button>
			</div>
		</Surface>
	</Section>

	<Section title="Recent activity" gap="md">
		<Surface padding="none" radius="xl">
			{#if data.activity.length}
				<ul class="rows activity" data-testid="activity">
					{#each data.activity as event (event.id)}
						<li class="row compact">
							<span class="dot" data-tone={event.tone} aria-hidden="true"></span>
							<div class="main">
								<p class="title small">{event.label}</p>
								<p class="meta">
									{event.device ? `${event.device} · ` : ''}{timeAgo(event.at, now)}
								</p>
							</div>
						</li>
					{/each}
				</ul>
			{:else}
				<p class="empty">Nothing yet. Sign-ins and changes to your passkeys appear here.</p>
			{/if}
		</Surface>
	</Section>

	<Button
		variant="danger"
		block
		icon="sign-out"
		loading={signingOut}
		onclick={leave}
		data-testid="sign-out"
	>
		Sign out of this device
	</Button>
</div>

<BottomSheet bind:open={renameOpen} title="Rename passkey" data-testid="rename-sheet">
	<form
		method="POST"
		action="?/rename"
		class="sheet-form"
		use:enhance={submit(
			() => 'Passkey renamed',
			() => (renameOpen = false)
		)}
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
	data-testid="remove-sheet"
>
	<form
		method="POST"
		action="?/remove"
		class="sheet-form"
		use:enhance={submit(
			() => 'Passkey removed',
			() => (removeOpen = false)
		)}
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
		<Button variant="ghost" block onclick={() => (removeOpen = false)}>Keep it</Button>
	</form>
</BottomSheet>

<BottomSheet
	bind:open={regenerateOpen}
	title="Create new recovery codes?"
	description="Your current codes stop working immediately. You’ll see the new ones once."
	data-testid="regenerate-sheet"
>
	<form method="POST" action="?/regenerate" class="sheet-form" use:enhance={regenerate}>
		<Button type="submit" block icon="refresh" loading={pending} data-testid="confirm-regenerate">
			Create new codes
		</Button>
		<Button variant="ghost" block onclick={() => (regenerateOpen = false)}>Cancel</Button>
	</form>
</BottomSheet>

<BottomSheet
	bind:open={codesOpen}
	title="Your new recovery codes"
	description="Save them now: this is the only time they’re shown."
	onclose={() => {
		if (!acknowledged) {
			toast.show('Your new codes are active. If you didn’t save them, create another set.', {
				tone: 'danger',
				duration: 6000
			});
		}
		freshCodes = [];
	}}
	data-testid="codes-sheet"
>
	<div class="sheet-form">
		<RecoveryCodes codes={freshCodes} bind:acknowledged data-testid="new-codes" />
		<Button block disabled={!acknowledged} onclick={closeCodes} data-testid="codes-done"
			>Done</Button
		>
	</div>
</BottomSheet>

<style>
	.back {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		min-height: var(--touch-target);
		margin-top: var(--space-2);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
	}

	.stack {
		display: grid;
		gap: var(--space-6);
	}

	.rows {
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.row {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-height: 4.5rem;
		padding: var(--space-3) var(--space-4);
		border-top: 1px solid var(--color-hairline);
	}

	.row:first-child {
		border-top: 0;
	}

	.row.compact {
		min-height: 3.5rem;
	}

	.glyph {
		display: grid;
		place-items: center;
		flex: none;
		width: 2.5rem;
		height: 2.5rem;
		border-radius: var(--radius-md);
		background: var(--color-surface-2);
		border: 1px solid var(--color-border);
		color: var(--color-accent-text);
	}

	.main {
		flex: 1;
		min-width: 0;
		display: grid;
		gap: 2px;
	}

	.title {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: var(--space-2);
		font-weight: var(--weight-semibold);
		overflow-wrap: anywhere;
	}

	.title.small {
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
	}

	.meta {
		font-size: var(--text-xs);
		color: var(--color-text-tertiary);
	}

	.actions {
		display: flex;
		flex: none;
	}

	.note,
	.empty {
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
		color: var(--color-text-secondary);
	}

	.empty {
		padding: var(--space-5) var(--space-4);
	}

	.codes {
		display: grid;
		justify-items: start;
		gap: var(--space-3);
	}

	.codes-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		width: 100%;
	}

	.codes-count {
		display: flex;
		align-items: baseline;
		gap: var(--space-2);
	}

	.codes-count .numeric {
		font-family: var(--font-display);
		font-size: var(--text-3xl);
		font-weight: var(--weight-black);
		line-height: 1;
	}

	.of {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.meter {
		display: grid;
		grid-template-columns: repeat(10, 1fr);
		gap: 4px;
		width: 100%;
	}

	.pip {
		height: 6px;
		border-radius: var(--radius-full);
		background: var(--color-surface-3);
	}

	.pip.on {
		background: var(--color-accent);
	}

	.dot {
		flex: none;
		width: 8px;
		height: 8px;
		margin: 0 var(--space-1);
		border-radius: 50%;
		background: var(--color-text-tertiary);
	}

	.dot[data-tone='positive'] {
		background: var(--color-positive);
	}

	.dot[data-tone='warning'] {
		background: var(--color-warning);
	}

	.sheet-form {
		display: grid;
		gap: var(--space-3);
		padding-bottom: var(--space-2);
	}
</style>
