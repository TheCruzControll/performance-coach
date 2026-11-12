<!--
  @component
  One conversation's sheet, opened from its row in Recent conversations: rename it, or archive it.
  - Rename: the title as it stands, Save busy while it is sent; the list loads again with the new
    name. A refused or failed save says so inline, and Retry sends it again.
  - Archive: busy while it is sent; the sheet closes, the conversation leaves Recent for Archived
    conversations, and a toast offers Undo, which unarchives it (a failed Undo offers Retry). A
    failed archive says so inline, with Retry.
  ThreadList fetches this on the first press, so the list ships without it.
-->
<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import TextField from '#lib/ui/components/TextField.svelte';
	import { COACH_NOTICES, SCREEN_FAILURE_LABEL } from '#lib/ui/coach/coach-notices.ts';
	import { toast } from '#lib/ui/toast.svelte.ts';
	import { manageThread, THREAD_TITLE_CHARS, type ThreadAction } from './manage';
	import type { ThreadRowView } from './words';

	interface Props {
		open: boolean;
		thread: ThreadRowView;
		/** Called before the list loads again after a change (ThreadList's older pages). */
		onchanged: () => void;
	}

	let { open = $bindable(), thread, onchanged }: Props = $props();

	// svelte-ignore state_referenced_locally
	let title = $state(thread.title);
	let sending = $state<ThreadAction | null>(null);
	let failed = $state<ThreadAction | null>(null);

	const blank = $derived(title.trim() === '');

	async function rename(event?: SubmitEvent) {
		event?.preventDefault();
		if (blank || sending) return;
		sending = 'rename';
		failed = null;
		const done = await manageThread(thread.id, { action: 'rename', title });
		if (done) {
			onchanged();
			await invalidateAll();
			open = false;
		} else failed = 'rename';
		sending = null;
	}

	async function archive() {
		if (sending) return;
		sending = 'archive';
		failed = null;
		const done = await manageThread(thread.id, { action: 'archive' });
		sending = null;
		if (!done) {
			failed = 'archive';
			return;
		}
		open = false;
		const changed = onchanged; // Undo runs after the sheet has gone
		changed();
		await invalidateAll();
		toast.show('Conversation archived', {
			duration: 6000,
			action: { label: 'Undo', onclick: () => void undo(thread.id, changed) }
		});
	}

	async function undo(id: string, changed: () => void) {
		if (await manageThread(id, { action: 'unarchive' })) {
			changed();
			return invalidateAll();
		}
		toast.show(SCREEN_FAILURE_LABEL.action_failed, {
			tone: 'danger',
			duration: 0,
			action: { label: 'Try again', onclick: () => void undo(id, changed) }
		});
	}

	const failure = COACH_NOTICES.action_failed;
</script>

{#snippet retry(action: ThreadAction, run: () => void)}
	{#if failed === action}
		<Notice tone="danger" title={failure.title} data-testid={`${action}-failed`}>
			<p>{failure.body}</p>
			<div class="action">
				<Button variant="secondary" size="sm" icon="refresh" onclick={run}>Try again</Button>
			</div>
		</Notice>
	{/if}
{/snippet}

<BottomSheet bind:open title="Manage conversation" data-testid="manage-sheet">
	<form class="manage" onsubmit={rename} novalidate>
		<TextField
			label="Name"
			bind:value={title}
			maxlength={THREAD_TITLE_CHARS}
			autocapitalize="sentences"
			enterkeyhint="done"
			error={blank ? 'Give it a name' : null}
			data-testid="rename-field"
		/>
		{@render retry('rename', rename)}
		<Button
			type="submit"
			block
			loading={sending === 'rename'}
			disabled={blank || sending === 'archive'}
			data-testid="rename-save">Save name</Button
		>
	</form>
	<div class="archive">
		<p class="hint">Archived conversations stay under Archived conversations, read-only.</p>
		{@render retry('archive', archive)}
		<Button
			variant="secondary"
			block
			icon="lock"
			loading={sending === 'archive'}
			disabled={sending === 'rename'}
			onclick={archive}
			data-testid="archive">Archive conversation</Button
		>
	</div>
</BottomSheet>

<style>
	.manage,
	.archive {
		display: grid;
		gap: var(--space-3);
	}

	.archive {
		margin-top: var(--space-5);
		padding-top: var(--space-5);
		border-top: 1px solid var(--color-hairline);
	}

	.hint {
		margin: 0;
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.action {
		margin-top: var(--space-2);
	}
</style>
