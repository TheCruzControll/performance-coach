<!--
  Train's Start date screen (start.server.ts): when week 1 starts, and moving it while no training
  has begun. A native form, so it posts before JavaScript runs; once it does, the post goes in
  place: busy while it is on its way (a second tap posts nothing), then the toast ('Start moved to
  Mon 23 Nov · version 2') and Train. A refusal says why under the choices; a post that failed on
  its way says the plan has not changed, and the button says Try again. Offline, the button is
  disabled and says why.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { enhance } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import Button from '#lib/ui/components/Button.svelte';
	import ChoiceGroup from '#lib/ui/components/ChoiceGroup.svelte';
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import Surface from '#lib/ui/components/Surface.svelte';
	import { toast } from '#lib/ui/toast.svelte.ts';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const TRAIN = resolve('/(app)/train');
	const TODAY = resolve('/(app)/today');

	const FAILED = 'Couldn’t move it. Your plan hasn’t changed. Try again.';
	/** What a refusal's reason (409) says. */
	const REFUSED: Record<string, string> = {
		version: 'Your plan changed meanwhile, so the dates were loaded again. Pick one again.',
		started: 'Your program has started, so its start stays where it is.',
		logged: 'You’ve logged training on it, so its start stays where it is.'
	};

	const open = $derived(data.state === 'open' ? data : null);
	const card = $derived(data.state === 'card' ? data.card : null);

	// svelte-ignore state_referenced_locally
	let start = $state(open?.chosen ?? null);
	let pending = $state(false);
	let failure = $state<string | null>(null);
	let reloading = $state(false);
	let online = $state(true);
	onMount(() => (online = navigator.onLine));

	/** What the form's own answer says, before JavaScript runs (a native post). */
	const answered = $derived.by(() => {
		if (!form) return null;
		if ('words' in form) return null;
		if ('errors' in form && form.errors) return Object.values(form.errors)[0] ?? FAILED;
		if ('reason' in form) return REFUSED[String(form.reason)] ?? FAILED;
		return 'message' in form ? String(form.message) : FAILED;
	});
	const message = $derived(failure ?? answered);

	async function reload() {
		reloading = true;
		await invalidateAll();
		reloading = false;
	}
</script>

<svelte:window ononline={() => (online = true)} onoffline={() => (online = false)} />

<svelte:head>
	<title>Start date · Train · Performance Coach</title>
</svelte:head>

<a class="back" href={TRAIN} data-testid="back-to-train">
	<Icon name="chevron-left" size={18} /> Train
</a>
<PageHeader title="Start date" eyebrow="Program" />

<div class="stack" data-testid="start-date">
	{#if card}
		<Surface padding="none" radius="xl">
			<EmptyState
				icon={card.icon}
				tone={card.tone}
				title={card.title}
				description={card.description}
				data-testid={card.id}
			/>
		</Surface>
		<div aria-busy={reloading}>
			<ListRow
				icon={card.next.to === 'retry' ? 'refresh' : card.next.to === 'train' ? 'train' : 'today'}
				title={card.next.label}
				href={card.next.to === 'retry' ? undefined : card.next.to === 'train' ? TRAIN : TODAY}
				onclick={card.next.to === 'retry' ? reload : undefined}
				data-testid="start-next"
			/>
		</div>
	{:else if open}
		<p class="current" data-testid="start-current">{open.current}</p>
		{#if form && 'words' in form}
			<Notice tone="positive" title="Start moved" data-testid="start-moved">
				{form.words}. <a href={TRAIN}>See it on Train</a>
			</Notice>
		{/if}
		<form
			method="POST"
			action="?/move"
			aria-busy={pending ? 'true' : undefined}
			use:enhance={({ cancel }) => {
				if (pending || !navigator.onLine) return cancel();
				pending = true;
				failure = null;
				return async ({ result, update }) => {
					pending = false;
					if (result.type === 'success' && result.data?.words) {
						toast.show(String(result.data.words), { tone: 'positive' });
						// eslint-disable-next-line svelte/no-navigation-without-resolve -- Train's path, from start.server.ts
						await goto(String(result.data.href));
					} else if (result.type === 'failure') {
						const data = result.data ?? {};
						const errors = data.errors as Record<string, string> | undefined;
						// The choices as they are now (a new day, a newer version), the pick kept if offered.
						await invalidateAll();
						if (!open?.options.some((o) => o.value === start)) start = open?.chosen ?? null;
						failure = errors
							? (Object.values(errors)[0] ?? FAILED)
							: (REFUSED[String(data.reason)] ?? (data.message ? String(data.message) : FAILED));
					} else if (result.type === 'error') {
						failure = FAILED;
					} else {
						await update();
					}
				};
			}}
		>
			<input type="hidden" name="version" value={open.version} />
			<ChoiceGroup
				legend="When week 1 starts"
				name="start"
				variant="card"
				options={open.options}
				bind:value={start}
				data-testid="start-choices"
			/>
			<p class="note">
				Your program is planned again from your profile for the new dates. Goals with a date keep
				it, and the change is listed in History.
			</p>
			{#if message}
				<Notice tone="danger" data-testid="start-failed">{message}</Notice>
			{/if}
			{#if !online}
				<p class="note" data-testid="start-offline">You’re offline. Connect to move the start.</p>
			{/if}
			<Button
				type="submit"
				block
				loading={pending}
				disabled={!online || !start || start === open.chosen}
				data-testid="move-start">{failure ? 'Try again' : 'Move the start'}</Button
			>
		</form>
	{/if}
</div>

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

	@media (hover: hover) and (pointer: fine) {
		.back:hover {
			color: var(--color-text);
		}
	}

	.stack,
	form {
		display: grid;
		gap: var(--space-5);
	}

	.current {
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
	}

	.note {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}
</style>
