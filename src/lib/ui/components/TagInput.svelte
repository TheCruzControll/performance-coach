<!--
  @component
  A short list of free-text items (movements to avoid, exercises): type, then Add (or Enter);
  each item is a removable pill. Optional quick suggestions add with one tap.
-->
<script lang="ts">
	import Icon from './Icon.svelte';

	interface Props {
		label: string;
		value: string[];
		placeholder?: string;
		hint?: string;
		error?: string | null;
		suggestions?: readonly string[];
		max?: number;
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
		'data-testid': testId
	}: Props = $props();

	const id = $props.id();
	let draft = $state('');
	let announcement = $state('');

	const has = (item: string) => value.some((v) => v.toLowerCase() === item.toLowerCase());
	const open = $derived(suggestions.filter((s) => !has(s)).slice(0, 6));

	function add(item = draft) {
		const text = item.trim();
		if (!text || has(text) || value.length >= max) return;
		value = [...value, text];
		announcement = `Added ${text}`;
		if (item === draft) draft = '';
	}

	function remove(item: string) {
		value = value.filter((v) => v !== item);
		announcement = `Removed ${item}`;
	}
</script>

<div class="tags" class:invalid={Boolean(error)} data-testid={testId}>
	<label class="label" for={id}>{label}</label>
	{#if value.length}
		<ul class="list" aria-label={label}>
			{#each value as item (item)}
				<li class="tag">
					<span>{item}</span>
					<button
						type="button"
						class="remove"
						aria-label={`Remove ${item}`}
						onclick={() => remove(item)}
					>
						<Icon name="close" size={14} />
					</button>
				</li>
			{/each}
		</ul>
	{/if}
	<div class="entry">
		<input
			{id}
			class="input"
			type="text"
			bind:value={draft}
			{placeholder}
			enterkeyhint="done"
			maxlength={80}
			aria-invalid={error ? 'true' : undefined}
			aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
			onkeydown={(e) => {
				if (e.key === 'Enter') {
					e.preventDefault();
					add();
				}
			}}
		/>
		<button type="button" class="add" onclick={() => add()} disabled={!draft.trim()}>Add</button>
	</div>
	{#if open.length}
		<div class="suggestions" role="group" aria-label={`Suggestions for ${label}`}>
			{#each open as s (s)}
				<button type="button" class="suggestion" onclick={() => add(s)}>+ {s}</button>
			{/each}
		</div>
	{/if}
	{#if error}
		<p class="error" id="{id}-error" role="alert">{error}</p>
	{:else if hint}
		<p class="hint" id="{id}-hint">{hint}</p>
	{/if}
	<p class="visually-hidden" role="status">{announcement}</p>
</div>

<style>
	.tags {
		display: grid;
		gap: var(--space-2);
	}

	.label {
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
	}

	.list,
	.suggestions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.tag {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		min-height: var(--touch-target);
		padding-left: var(--space-3);
		border-radius: var(--radius-full);
		background: var(--color-surface-3);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
	}

	.remove {
		display: grid;
		place-items: center;
		width: var(--touch-target);
		height: var(--touch-target);
		border-radius: 50%;
		color: var(--color-text-secondary);
	}

	.entry {
		display: flex;
		gap: var(--space-2);
	}

	.input {
		flex: 1;
		min-width: 0;
		min-height: 3rem;
		padding: 0 var(--space-4);
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		background: var(--color-surface-2);
		font-size: max(1rem, var(--text-base));
	}

	.input:focus-visible {
		outline: none;
		border-color: var(--color-accent);
		box-shadow: 0 0 0 3px var(--color-accent-ring);
	}

	.add {
		min-width: 4rem;
		min-height: 3rem;
		border-radius: var(--radius-md);
		background: var(--color-surface-3);
		font-weight: var(--weight-semibold);
	}

	.add:disabled {
		color: var(--color-text-disabled);
	}

	.suggestion {
		min-height: var(--touch-target);
		padding: 0 var(--space-3);
		border-radius: var(--radius-full);
		border: 1px dashed var(--color-border-strong);
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.invalid .input {
		border-color: var(--color-danger);
	}

	.hint,
	.error {
		font-size: var(--text-xs);
		color: var(--color-text-tertiary);
	}

	.error {
		color: var(--color-danger);
	}
</style>
