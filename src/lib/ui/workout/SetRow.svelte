<!--
  @component
  One set of the current exercise, as a list item (set-words.ts's setRows): its number, what it
  asks for (or what was done), and its state in words, never by colour alone.
  - to do: the target, quiet; current: the target, ringed in the accent, marked aria-current
  - done: what was done, with a tick; missed: what was done and how many reps were missed
  - skipped, extra and not saved: said in words ('Not saved on this device' in the danger tone)
  A logged or skipped set given `onedit` is a button that opens its editor, named 'Edit set 2 …';
  its first hover or touch (a touch enters it first) calls `onintent`; a key press loads it as it opens, so the editor's code is on its way before the
  tap lands. From a desktop pointer it strengthens its border on hover; the keyboard gets a ring.
  Given `onplates` (a set of an exercise loaded with a bar or plates), a plate button beside it
  opens the plate calculator at the set's weight; its first touch calls `onplatesintent`.
-->
<script lang="ts">
	import IconButton from '#lib/ui/components/IconButton.svelte';
	import type { SetRowWords } from './set-words.ts';

	interface Props {
		row: SetRowWords;
		/** Opens the set's editor; a row without it is display only. */
		onedit?: (event: MouseEvent) => void;
		/** The first sign the owner may tap: load the editor. */
		onintent?: () => void;
		/** Opens the plate calculator for this set; a row without it has no plate button. */
		onplates?: (event: MouseEvent) => void;
		/** The plate button's first touch: load the calculator. */
		onplatesintent?: () => void;
	}

	let { row, onedit, onintent, onplates, onplatesintent }: Props = $props();
</script>

<li
	class:plated={!!onplates}
	data-state={row.state}
	aria-current={row.state === 'current' ? 'step' : undefined}
	data-testid="set"
>
	<!-- One element either way (Surface's way): a button to edit, else a plain row. The
	     handlers go through a spread: a row without them is not interactive. No form encloses it,
	     so the button needs no type. The space after 'Edit set' sits inside its span, so a
	     display-only row starts with its number, not a space. -->
	<svelte:element
		this={onedit ? 'button' : 'div'}
		class="set"
		{...{ onclick: onedit, onpointerenter: onintent }}
	>
		{#if onedit}<span class="visually-hidden">Edit set&nbsp;</span>{/if}<span class="index tabular"
			>{row.setIndex}</span
		>
		<span class="text">{row.text}</span>
		<span class="state">
			<span>{row.word}</span>
		</span>
	</svelte:element><!-- No space between: the row's text ends with its state word. -->{#if onplates}
		<IconButton
			icon="plate"
			label="Plates for set {row.setIndex}"
			onclick={onplates}
			onpointerdown={onplatesintent}
			data-testid="set-plates"
		/>
	{/if}
</li>

<style>
	li {
		display: flex;
		align-items: center;
		gap: var(--space-1);
	}

	.set {
		flex: 1;
		min-width: 0;
		position: relative;
		display: grid;
		grid-template-columns: 1.75rem minmax(0, 1fr) auto;
		align-items: center;
		gap: var(--space-3);
		min-height: 2.75rem;
		padding: var(--space-2) var(--space-3);
		border-radius: var(--radius-md);
		border: 1px solid transparent;
		font-size: var(--text-base);
	}

	/* Beside a plate button the row gives up spare spacing, not its text's width: a done set
	   ('100 kg × 5 reps · RPE 9') still fits one line at 393 px, so completing it shifts nothing. */
	.plated .set {
		grid-template-columns: 1rem minmax(0, 1fr) auto;
		column-gap: var(--space-2);
		padding-inline: var(--space-2);
	}

	button.set {
		width: 100%;
		margin: 0;
		border-color: var(--color-hairline);
		background: none;
		color: inherit;
		font: inherit;
		text-align: start;
		cursor: pointer;
		transition: border-color var(--duration-fast) var(--ease-standard);
	}

	@media (hover: hover) and (pointer: fine) {
		button.set:hover {
			border-color: var(--color-border-strong);
		}
	}

	.index {
		color: var(--color-text-tertiary);
		font-size: var(--text-sm);
	}

	.text {
		overflow-wrap: anywhere;
		color: var(--color-text-secondary);
	}

	/* As wide as 'To do', so a row turning Now or Done keeps its words in place. */
	.state {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		min-width: 2.75rem;
		font-size: var(--text-sm);
		color: var(--color-text-tertiary);
	}

	[data-state='current'] .set {
		border-color: var(--color-accent);
		background: var(--color-surface-2);
	}

	[data-state='current'] .text,
	[data-state='done'] .text,
	[data-state='missed'] .text,
	[data-state='extra'] .text {
		color: var(--color-text);
		font-weight: var(--weight-medium);
	}

	[data-state='current'] .state {
		color: var(--color-accent-text);
		font-weight: var(--weight-semibold);
	}

	[data-state='done'] .state {
		color: var(--color-positive);
	}

	/* Done is a tick drawn in CSS (no icon to load per row), and the word for assistive technology. */
	[data-state='done'] .state::before {
		content: '';
		width: 0.4rem;
		height: 0.8rem;
		margin: 0 0.3rem 0.2rem;
		border: solid currentColor;
		border-width: 0 2px 2px 0;
		transform: rotate(45deg);
	}

	[data-state='done'] .state > span {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip-path: inset(50%);
		white-space: nowrap;
	}

	[data-state='missed'] .state {
		color: var(--color-warning);
	}

	[data-state='not-saved'] .state {
		color: var(--color-danger);
		font-weight: var(--weight-semibold);
	}
</style>
