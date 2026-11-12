<!--
  @component
  An archived conversation's banner: 'Archived · Unarchive to continue'. The conversation is
  read-only (the composer is disabled) until Unarchive returns it to Recent conversations, in
  place: the page loads again, open. Unarchive is busy while it is sent; a failure says so inline
  and Retry sends it again.
-->
<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import Button from '#lib/ui/components/Button.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import { COACH_NOTICES } from '#lib/ui/coach/coach-notices.ts';
	import { manageThread } from './manage';

	let { id }: { id: string } = $props();

	let sending = $state(false);
	let failed = $state(false);

	async function unarchive() {
		sending = true;
		failed = false;
		const thread = await manageThread(id, { action: 'unarchive' });
		if (thread) await invalidateAll();
		else failed = true;
		sending = false;
	}

	const failure = COACH_NOTICES.action_failed;
</script>

<Notice
	tone={failed ? 'danger' : 'neutral'}
	icon={failed ? 'alert' : 'lock'}
	title={failed ? failure.title : 'Archived · Unarchive to continue'}
	data-testid="archived-banner"
>
	<p>{failed ? failure.body : 'This conversation is read-only while it’s archived.'}</p>
	<div class="action">
		<Button
			variant="secondary"
			size="sm"
			icon={failed ? 'refresh' : undefined}
			loading={sending}
			onclick={unarchive}
			data-testid="unarchive">{failed ? 'Try again' : 'Unarchive'}</Button
		>
	</div>
</Notice>

<style>
	.action {
		margin-top: var(--space-2);
	}
</style>
