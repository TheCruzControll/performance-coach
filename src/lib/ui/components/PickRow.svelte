<!--
  @component
  A pick-one (or pick-several) question as a row (Paper, 9 · "Nutrition phase"): the question,
  the answer at its end ("Choose" in tertiary until there is one), a chevron. Tapping opens a
  BottomSheet titled with the question, holding a `ChoiceGroup` card list; a pick closes it
  (pick-several stays open until closed). From the keyboard the arrow keys move the pick and keep
  the sheet open, and Enter or Space closes it on the focused answer. An error is one red line
  under the row, and the row is `aria-invalid`, so a refused save focuses it. From 1024 px the
  sheet is the centred dialog.

  The sheet sits inside the row's wrapper, so a list of rows keeps a hairline under each but the
  last, as ListRow's own do.
-->
<script lang="ts" generics="T extends string">
	import type { DisciplineTone } from '#lib/domain/profile/catalog.ts';
	import BottomSheet from './BottomSheet.svelte';
	import ChoiceGroup from './ChoiceGroup.svelte';
	import ListRow from './ListRow.svelte';

	interface Option {
		value: T;
		label: string;
		hint?: string;
		tone?: DisciplineTone;
	}

	interface Props {
		label: string;
		/** The sheet's line under its title. */
		description?: string;
		options: readonly Option[];
		value?: T | null;
		values?: T[];
		multiple?: boolean;
		/** The answer in words, when the picked labels are not it ("3 days", "Any day"). */
		summary?: string;
		placeholder?: string;
		error?: string | null;
		onchange?: () => void;
		'data-testid'?: string;
	}

	let {
		label,
		description,
		options,
		value = $bindable(null),
		values = $bindable([]),
		multiple = false,
		summary,
		placeholder = 'Choose',
		error,
		onchange,
		'data-testid': testId
	}: Props = $props();

	const id = $props.id();
	let open = $state(false);

	const picked = $derived(
		multiple
			? options
					.filter((o) => values.includes(o.value))
					.map((o) => o.label)
					.join(', ')
			: options.find((o) => o.value === value)?.label
	);
	const answer = $derived(summary ?? (picked || undefined));

	/** An arrow key is moving the pick: the change it fires keeps the sheet open. */
	let stepping = false;

	function changed() {
		onchange?.();
		const stepped = stepping;
		stepping = false;
		// One answer: the pick is the answer, and the sheet goes (focus returns to the row).
		if (!multiple && !stepped) open = false;
	}

	const isRadio = (target: EventTarget | null): target is HTMLInputElement =>
		target instanceof HTMLInputElement && target.type === 'radio';

	/** Arrows step through the answers; Enter or Space picks the focused one and closes. */
	function onkeydown(event: KeyboardEvent) {
		if (multiple || !isRadio(event.target)) return;
		stepping = event.key.startsWith('Arrow');
		if (event.key !== 'Enter' && event.key !== ' ') return;
		// Enter would otherwise submit the form the row sits in.
		event.preventDefault();
		if (!event.target.checked) event.target.click();
		open = false;
	}

	/** A tap or a click closes the sheet, on the current answer too (it fires no change). */
	function onclick(event: MouseEvent) {
		if (!multiple && isRadio(event.target) && event.detail > 0) open = false;
	}
</script>

<div class="pick">
	<ListRow
		title={label}
		value={answer ?? placeholder}
		valueTone={answer ? undefined : 'muted'}
		onclick={() => (open = true)}
		aria-haspopup="dialog"
		aria-invalid={error ? 'true' : undefined}
		aria-describedby={error ? `${id}-error` : undefined}
		data-testid={testId}
	/>
	{#if error}<p class="error" id="{id}-error">{error}</p>{/if}

	<BottomSheet bind:open title={label} {description}>
		{#if multiple}
			<ChoiceGroup
				legend={label}
				hideLegend
				variant="card"
				multiple
				{options}
				bind:values
				onchange={changed}
			/>
		{:else}
			<!-- The radios' keys and clicks bubble here: the group itself is the native one. -->
			<div role="presentation" {onkeydown} {onclick} onpointerdown={() => (stepping = false)}>
				<ChoiceGroup
					legend={label}
					hideLegend
					variant="card"
					hintPlacement="end"
					{options}
					bind:value
					onchange={changed}
				/>
			</div>
		{/if}
	</BottomSheet>
</div>

<style>
	.pick {
		display: grid;
	}

	/* The last row of a list has no hairline; the sheet after the row keeps it from being last. */
	.pick:last-child > :global(.row) {
		border-bottom-color: transparent;
	}

	/* One red line under the row: the words are the message. */
	.error {
		margin-top: var(--space-1);
		font: var(--type-caption);
		color: var(--color-danger);
	}
</style>
