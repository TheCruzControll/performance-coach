<!--
  @component
  What the owner says back to a proposal card (M5 plan, coach-proposal-decisions), in a sheet
  loaded on demand with the first Reject or 'Ask for changes':
  - reject: an optional reason (up to 500 characters), kept with the decision; the coach reads it
    next turn, as the owner's words, never as instructions. While the rejection is on its way the
    form is aria-busy and Reject is busy, so a second tap sends nothing.
  - revise: what should change (required), which the screen sends to the coach as a turn about
    the proposal; the coach drafts a revision that replaces it.
  `onsubmit` gets the words (null for a rejection with no reason); the screen closes the sheet.
-->
<script lang="ts">
	import { CHANGE_REQUEST_MAX, REJECT_REASON_MAX } from '#lib/domain/coach/cards.ts';
	import BottomSheet from '../components/BottomSheet.svelte';
	import Button from '../components/Button.svelte';
	import TextArea from '../components/TextArea.svelte';

	interface Props {
		open: boolean;
		mode: 'reject' | 'revise';
		/** The proposal's title. */
		title: string;
		/** The rejection is on its way. */
		pending?: boolean;
		onsubmit: (words: string | null) => void;
		onclose?: () => void;
	}

	let { open = $bindable(), mode, title, pending = false, onsubmit, onclose }: Props = $props();

	const COPY = {
		reject: {
			heading: 'Reject this change',
			lead: 'Your plan stays as it is. Saying why helps the coach suggest something that fits better.',
			label: 'Why not?',
			hint: 'The coach reads this before its next answer.',
			placeholder: 'Too much on Fridays, I prefer lunges…',
			action: 'Reject',
			max: REJECT_REASON_MAX
		},
		revise: {
			heading: 'Ask for changes',
			lead: 'The coach drafts a new version from your words. It replaces this one, and nothing changes until you accept it.',
			label: 'What should change?',
			hint: 'Sent to the coach as your next message.',
			placeholder: 'Only this week, keep the rest…',
			action: 'Send to coach',
			max: CHANGE_REQUEST_MAX
		}
	} as const;

	const copy = $derived(COPY[mode]);
	let words = $state<string | null>('');
	const said = $derived(words?.trim() ?? '');
	const ready = $derived(!pending && (mode === 'reject' || said.length > 0));

	// Each opening starts empty.
	$effect(() => {
		if (open) words = '';
	});

	function submit() {
		if (ready) onsubmit(said || null);
	}
</script>

<BottomSheet
	bind:open
	title={copy.heading}
	description={title}
	{onclose}
	data-testid="decision-sheet"
>
	<div class="form" aria-busy={pending ? 'true' : undefined} data-testid="decision-form">
		<p class="lead">{copy.lead}</p>
		<TextArea
			label={copy.label}
			optional={mode === 'reject'}
			bind:value={words}
			hint={copy.hint}
			placeholder={copy.placeholder}
			maxlength={copy.max}
			rows={3}
			data-testid="decision-words"
		/>
	</div>
	{#snippet footer()}
		<Button
			block
			variant={mode === 'reject' ? 'danger' : 'primary'}
			loading={pending}
			disabled={!ready && !pending}
			onclick={submit}
			data-testid="decision-submit">{copy.action}</Button
		>
	{/snippet}
</BottomSheet>

<style>
	.form {
		display: grid;
		gap: var(--space-5);
		padding-bottom: var(--space-2);
	}

	.lead {
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
		color: var(--color-text-secondary);
	}
</style>
