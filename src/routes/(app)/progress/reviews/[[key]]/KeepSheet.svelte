<!--
  @component
  'Keep next week as planned', mounted by next-week-actions with the first tap on it: an optional
  reason, stored with the decision. While it is on its way the form is aria-busy and Keep is busy,
  so a second tap sends nothing; offline, Keep is disabled; if it fails, the sheet says why and
  Retry sends it again. Once kept, the sheet closes and the review shows the decision.
-->
<script lang="ts">
	import { REJECT_REASON_MAX } from '#lib/domain/coach/cards.ts';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import TextArea from '#lib/ui/components/TextArea.svelte';
	import type { KeepSheetProps } from './next-week-actions.svelte';

	let { open = $bindable(), note = $bindable(), ui, onsubmit }: KeepSheetProps = $props();

	const pending = $derived(ui.pending === 'keep');
	const failure = $derived(ui.failed === 'keep' ? ui.failure : null);
	let online = $state(navigator.onLine);
</script>

<svelte:window ononline={() => (online = true)} onoffline={() => (online = false)} />

<BottomSheet
	bind:open
	title="Keep next week as planned"
	description="None of these changes are applied."
	data-testid="keep-sheet"
>
	<div class="form" aria-busy={pending ? 'true' : undefined}>
		{#if failure}<Notice tone="danger" data-testid="keep-failure">{failure}</Notice>{/if}
		{#if !online}<Notice tone="warning">You’re offline. Keep it once you’re back online.</Notice
			>{/if}
		<TextArea
			label="Why keep it?"
			optional
			bind:value={note}
			hint="Kept with this decision, where your coach can read it."
			placeholder="A busy week at work, a race coming up…"
			maxlength={REJECT_REASON_MAX}
			rows={3}
			data-testid="keep-note"
		/>
	</div>
	{#snippet footer()}
		<Button
			block
			loading={pending}
			disabled={!online}
			onclick={() => pending || onsubmit()}
			data-testid="keep-submit">{failure ? 'Try again' : 'Keep as planned'}</Button
		>
	{/snippet}
</BottomSheet>

<style>
	.form {
		display: grid;
		gap: var(--space-4);
	}
</style>
