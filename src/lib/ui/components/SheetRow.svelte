<!--
  @component
  A row that opens a short sheet of fields (Paper, 9 · "Running and Muay Thai": "Tap a row to
  type"). The fields are the caller's, bound to its draft, so what is typed is kept when the sheet
  closes; there is no Done. The row shows the answer in words, or "Add" in tertiary. A field
  error shows as one red line under the row too, and marks the row invalid, so a refused save
  focuses the row; opening it shows the field with its error. A danger row last in the sheet
  ("Remove this race") has no hairline, and `children` is handed a `close` for it.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import BottomSheet from './BottomSheet.svelte';
	import ListRow from './ListRow.svelte';

	interface Props {
		label: string;
		/** The sheet's title, when it differs from the row's ("A recent race"). */
		title?: string;
		description?: string;
		value?: string;
		placeholder?: string;
		error?: string | null;
		/** The fields, and a danger row last when the sheet removes something. */
		children: Snippet<[close: () => void]>;
		'data-testid'?: string;
	}

	let {
		label,
		title,
		description,
		value,
		placeholder = 'Add',
		error,
		children,
		'data-testid': testId
	}: Props = $props();

	const id = $props.id();
	let open = $state(false);
</script>

<div class="sheet-row">
	<ListRow
		title={label}
		value={value ?? placeholder}
		valueTone={value ? undefined : 'muted'}
		onclick={() => (open = true)}
		aria-haspopup="dialog"
		aria-invalid={error ? 'true' : undefined}
		aria-describedby={error ? `${id}-error` : undefined}
		data-testid={testId}
	/>
	{#if error}<p class="error" id="{id}-error">{error}</p>{/if}

	<BottomSheet bind:open title={title ?? label} {description}>
		<div class="fields">{@render children(() => (open = false))}</div>
	</BottomSheet>
</div>

<style>
	.sheet-row {
		display: grid;
	}

	/* The last row of a list has no hairline; the sheet after the row keeps it from being last. */
	.sheet-row:last-child > :global(.row) {
		border-bottom-color: transparent;
	}

	.error {
		margin-top: var(--space-1);
		font: var(--type-caption);
		color: var(--color-danger);
	}

	.fields {
		display: grid;
		gap: var(--space-5);
	}
</style>
