<!--
  @component
  A short list of free-text items (movements to avoid, exercises): type, then Add or Return.
  Each item is a pill whose remove button has a 44 px hit area, and suggestions add in one
  tap. Items are trimmed, a case-insensitive repeat is refused, and `maxlength` and `max` are
  enforced. Every addition, removal and refusal is announced politely; a refusal keeps what
  was typed.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import Button from './Button.svelte';
	import IconButton from './IconButton.svelte';

	interface Props {
		label: string;
		value?: string[];
		placeholder?: string;
		hint?: string;
		/** Replaces the hint while shown. */
		error?: string | null;
		suggestions?: readonly string[];
		/** The most items the list holds. */
		max?: number;
		/** The longest item, in characters. */
		maxlength?: number;
		'data-testid'?: string;
	}

	let {
		label,
		value = $bindable([]),
		placeholder,
		hint,
		error = null,
		suggestions = [],
		max = 40,
		maxlength = 80,
		'data-testid': testId
	}: Props = $props();

	const id = $props.id();
	let draft = $state('');
	let announcement = $state('');
	let input = $state<HTMLInputElement>();
	let list = $state<HTMLElement>();
	let offered = $state<HTMLElement>();
	let timer: ReturnType<typeof setTimeout> | undefined;

	const find = (text: string) => value.find((v) => v.toLowerCase() === text.toLowerCase());
	const full = $derived(value.length >= max);
	const limit = $derived(`That’s the limit of ${max}. Remove one to add another.`);
	const open = $derived(
		full ? [] : suggestions.filter((s) => s.length <= maxlength && !find(s)).slice(0, 6)
	);
	// Shown in place of the hint while it applies; the error replaces both.
	const note = $derived(
		full ? limit : draft.length >= maxlength ? `Up to ${maxlength} characters.` : hint
	);

	/** Clear, then set: a live region only speaks when its text changes, even to the same words. */
	function announce(text: string) {
		announcement = '';
		clearTimeout(timer);
		timer = setTimeout(() => (announcement = text), 100);
	}

	/** Keeps keyboard focus in place when the focused button in `group` goes away. */
	async function keepFocus(group: HTMLElement | undefined, index: number) {
		if (!group?.contains(document.activeElement)) return;
		await tick();
		const buttons = [...group.querySelectorAll('button')].filter((b) => b.isConnected);
		(buttons[index] ?? buttons[index - 1] ?? input)?.focus();
	}

	/** Adds `item` (the field's text by default); a refusal says why and keeps the text. */
	function add(item = draft) {
		const text = item.trim();
		if (!text) return false;
		const existing = find(text);
		if (existing) announce(`${existing} is already on the list`);
		else if (full) announce(limit);
		else {
			value = [...value, text];
			announce(
				value.length >= max ? `Added ${text}. That’s the limit of ${max}.` : `Added ${text}`
			);
			if (item === draft) draft = '';
			return true;
		}
		return false;
	}

	function remove(index: number) {
		const item = value[index];
		void keepFocus(list, index);
		value = value.filter((_, i) => i !== index);
		announce(`Removed ${item}`);
	}
</script>

<div class="field" class:invalid={Boolean(error)} data-testid={testId}>
	<label class="label" for={id}>{label}</label>
	{#if value.length}
		<ul class="list" aria-label={label} bind:this={list}>
			<!-- Keyed by position: a saved list may repeat an item, and a repeated key throws. -->
			{#each value as item, i (i)}
				<li class="tag">
					{item}
					<IconButton icon="close" size="sm" label="Remove {item}" onclick={() => remove(i)} />
				</li>
			{/each}
		</ul>
	{/if}
	<div class="entry">
		<input
			bind:this={input}
			bind:value={draft}
			{id}
			class="input"
			type="text"
			{placeholder}
			{maxlength}
			enterkeyhint="done"
			autocapitalize="sentences"
			autocomplete="off"
			aria-invalid={error ? 'true' : undefined}
			aria-describedby={error ? `${id}-error` : note ? `${id}-hint` : undefined}
			oninput={(e) => {
				if (e.currentTarget.value.length >= maxlength) announce(`Up to ${maxlength} characters`);
			}}
			onkeydown={(e) => {
				// Return adds (and never submits a surrounding form), except while an IME composes.
				if (e.key === 'Enter' && !e.isComposing) {
					e.preventDefault();
					add();
				}
			}}
		/>
		<Button
			variant="secondary"
			aria-label="Add to {label.toLowerCase()}"
			disabled={!draft.trim()}
			onclick={() => {
				// The button disables itself once the field clears: keep typing where you were.
				if (add()) input?.focus();
			}}>Add</Button
		>
	</div>
	{#if open.length}
		<div class="list offered" role="group" aria-label="Suggestions for {label}" bind:this={offered}>
			{#each open as suggestion, i (i)}
				<Button
					variant="ghost"
					size="sm"
					icon="plus"
					aria-label="Add {suggestion}"
					onclick={() => {
						void keepFocus(offered, i);
						add(suggestion);
					}}>{suggestion}</Button
				>
			{/each}
		</div>
	{/if}
	{#if error}
		<p class="message error" id="{id}-error" role="alert">{error}</p>
	{:else if note}
		<p class="message" id="{id}-hint">{note}</p>
	{/if}
	<p class="visually-hidden" role="status">{announcement}</p>
</div>

<style>
	.field {
		display: grid;
		gap: var(--space-2);
	}

	.label {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		justify-content: space-between;
		gap: var(--space-2);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
	}

	.list {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		padding: 0;
		list-style: none;
	}

	/* The remove button is 36 px with a 44 px hit area, which fills the pill's height. */
	.tag {
		display: flex;
		align-items: center;
		gap: var(--space-1);
		min-height: var(--touch-target);
		padding: 0 var(--space-1) 0 var(--space-4);
		border-radius: var(--radius-full);
		background: var(--color-surface-3);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		overflow-wrap: anywhere;
	}

	/* Quieter than the items: text buttons whose labels line up with the field's edge. */
	.offered {
		margin-inline-start: calc(var(--space-4) * -1);
	}

	.entry {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.input {
		width: 100%;
		min-width: 0;
		min-height: 3.5rem;
		padding: 0 var(--space-4);
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		background: var(--color-surface-2);
		box-shadow: inset 0 1px 0 0 var(--color-highlight);
		/* ≥ 16px: iOS Safari zooms into smaller inputs on focus. */
		font-size: max(1rem, var(--text-base));
	}

	.input::placeholder {
		color: var(--color-text-tertiary);
	}

	.input:focus-visible {
		outline: none;
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-ring);
	}

	.invalid .input {
		border-color: var(--color-danger);
	}

	.message {
		font-size: var(--text-xs);
		color: var(--color-text-tertiary);
	}

	.error {
		color: var(--color-danger);
	}
</style>
