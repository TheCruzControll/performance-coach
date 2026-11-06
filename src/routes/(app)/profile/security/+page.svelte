<script lang="ts">
	import type { Component } from 'svelte';
	import { enhance, type SubmitFunction } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import Badge from '#lib/ui/components/Badge.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import IconButton from '#lib/ui/components/IconButton.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import Section from '#lib/ui/components/Section.svelte';
	import Surface from '#lib/ui/components/Surface.svelte';
	import { shortDate } from '#lib/ui/time.ts';
	import { toast } from '#lib/ui/toast.svelte.ts';
	import type { SheetRequest } from './SecuritySheets.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Passkey = (typeof data.passkeys)[number];

	const now = $derived(new Date(data.now));
	const others = $derived(data.sessions.filter((s) => !s.current).length);
	const onlyPasskey = $derived(data.passkeys.length <= 1);

	// ---- add ------------------------------------------------------------------------------
	// The passkey and sign-out helpers are fetched on intent too: this screen's initial JS
	// stays within budget, and the WebAuthn library itself only ever loads on demand.
	const passkeys = () => import('#lib/client/passkeys.ts');
	let adding = $state(false);
	let addError = $state<string | null>(null);

	async function add() {
		if (adding) return;
		adding = true;
		addError = null;
		const { addPasskey, PasskeyError } = await passkeys();
		try {
			const { passkey } = await addPasskey();
			toast.show(`Passkey added: ${passkey.nickname}`, { tone: 'positive' });
			await invalidateAll();
		} catch (err) {
			// Step-up: the sheets confirm with an existing passkey, then add again.
			if (err instanceof PasskeyError && err.kind === 'reauth')
				open({ kind: 'reauth', retry: add });
			else
				addError = err instanceof PasskeyError ? err.message : 'Something went wrong. Try again.';
		} finally {
			adding = false;
		}
	}

	// ---- sheets (rename, remove, new codes): code-split, fetched on first intent -----------
	let sheets = $state<Promise<{ default: Component<{ request: SheetRequest | null }> }> | null>(
		null
	);
	let request = $state<SheetRequest | null>(null);

	function loadSheets() {
		sheets ??= import('./SecuritySheets.svelte');
	}

	function open(next: SheetRequest) {
		loadSheets();
		request = next;
	}

	const target = (p: Passkey) => ({ id: p.id, nickname: p.nickname });

	// ---- sessions ------------------------------------------------------------------------
	function submit(success: (data: Record<string, unknown>) => string): SubmitFunction {
		return ({ formElement }) =>
			async ({ result, update }) => {
				if (result.type === 'success') {
					toast.show(success(result.data ?? {}), { tone: 'positive' });
				} else if (result.type === 'failure' && result.data?.code === 'reauth_required') {
					open({ kind: 'reauth', retry: () => formElement.requestSubmit() });
				} else if (result.type === 'failure') {
					toast.show(String(result.data?.error ?? 'That didn’t work. Try again.'), {
						tone: 'danger'
					});
				}
				await update({ reset: false });
			};
	}

	// ---- sign out --------------------------------------------------------------------------
	let signingOut = $state(false);

	async function leave() {
		signingOut = true;
		try {
			const { signOut } = await import('#lib/client/signout.ts');
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
				onpointerdown={() => void passkeys()}
				onclick={add}
				data-testid="add-passkey"
			>
				Add passkey
			</Button>
		{/snippet}
		<Surface padding="none" radius="xl">
			<ul class="rows" data-testid="passkeys">
				{#each data.passkeys as passkey (passkey.id)}
					<li class="row" data-testid="passkey-row" data-passkey-id={passkey.id}>
						<span class="glyph" aria-hidden="true"><Icon name="passkey" size={22} /></span>
						<div class="main">
							<p class="title" data-testid="passkey-name">{passkey.nickname}</p>
							<p class="meta">
								{passkey.provider ?? (passkey.synced ? 'Synced passkey' : 'This device only')}
								· Added {shortDate(passkey.createdAt, now)}
							</p>
							<p class="meta">
								{passkey.lastUsedAt
									? `Last used ${passkey.lastUsedAgo ?? shortDate(passkey.lastUsedAt, now)}`
									: 'Not used to sign in yet'}
							</p>
						</div>
						<div class="actions">
							<IconButton
								icon="pencil"
								label="Rename {passkey.nickname}"
								size="sm"
								onpointerdown={loadSheets}
								onclick={() => open({ kind: 'rename', passkey: target(passkey) })}
								data-testid="rename-passkey"
							/>
							<IconButton
								icon="trash"
								label={onlyPasskey
									? `${passkey.nickname} is your only passkey`
									: `Remove ${passkey.nickname}`}
								size="sm"
								disabled={onlyPasskey}
								onpointerdown={loadSheets}
								onclick={() => open({ kind: 'remove', passkey: target(passkey) })}
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
					{@const recovery = s.kind === 'recovery'}
					<li class="row" data-testid="session-row" data-current={s.current} data-session-id={s.id}>
						<span class="glyph" aria-hidden="true">
							<Icon name={recovery ? 'key' : 'device'} size={22} />
						</span>
						<div class="main">
							<p class="title">
								{s.device}
								{#if s.current}<Badge tone="accent">This device</Badge>
								{:else if recovery}<Badge tone="warning">Recovery sign-in</Badge>{/if}
							</p>
							<p class="meta">
								{s.current
									? 'Active now'
									: `Active ${s.lastSeenAgo ?? shortDate(s.lastSeenAt, now)}`}
								· Signed in {shortDate(s.createdAt, now)} with {s.signedInWith}
							</p>
							{#if recovery}
								<p class="meta">
									It can only add a passkey, for 15 minutes. Not you? Sign it out and create new
									codes.
								</p>
							{/if}
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
					onpointerdown={loadSheets}
					onclick={() => open({ kind: 'regenerate' })}
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
									{event.device ? `${event.device} · ` : ''}{event.ago ?? shortDate(event.at, now)}
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

{#if sheets}
	{#await sheets then { default: SecuritySheets }}
		<SecuritySheets bind:request />
	{/await}
{/if}

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
</style>
