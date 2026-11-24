<!--
  @component
  The session's effort (Paper 4 · Train "How hard"), the body of the Effort row's sheet: 1 to 10
  as numerals in two rows of five, "Easy" and "All out" at the ends, and a sentence saying what
  the picked one means. A session's RPE is 1 to 10 (a mobility session is a 2 or 3), so the
  scale keeps the low end Paper's five numerals leave out. Native radios in a fieldset: one Tab
  stop, the arrows move the pick, and each is named by its numeral. A pick applies at once and the
  sheet stays open (the sentence answers it); "Leave it out" clears it and, as it goes, hands the
  focus to the first numeral.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import { SESSION_RPE_CHIPS } from './session-log.ts';
	import { effortSentence } from './session-words.ts';

	interface Props {
		value: number | null;
		onpick: (rpe: number | null) => void;
	}

	let { value, onpick }: Props = $props();

	const id = $props.id();
	const rows = [SESSION_RPE_CHIPS.slice(0, 5), SESSION_RPE_CHIPS.slice(5)];
	let scale: HTMLFieldSetElement | undefined = $state();

	/** The button goes with the pick: the focus moves to the scale, not to the page. */
	async function clear() {
		onpick(null);
		await tick();
		scale?.querySelector<HTMLInputElement>('.input')?.focus();
	}
</script>

<div class="scale">
	<fieldset class="effort" bind:this={scale} data-testid="effort-scale">
		<legend class="visually-hidden">Effort</legend>
		{#each rows as row, r (r)}
			<div class="row">
				{#each row as rpe (rpe)}
					<label class="numeral">
						<!-- `checked` through a spread, as ChoiceGroup does: no extra runtime helper. -->
						<input
							class="input"
							type="radio"
							name={id}
							value={String(rpe)}
							{...{ checked: value === rpe }}
							onchange={() => onpick(rpe)}
						/>
						<span class="face">{rpe}</span>
					</label>
				{/each}
			</div>
		{/each}
		<p class="ends" aria-hidden="true"><span>Easy</span><span>All out</span></p>
	</fieldset>

	<p class="sentence" role="status">{effortSentence(value)}</p>
	{#if value !== null}
		<button type="button" class="clear" onclick={clear} data-testid="effort-clear">
			Leave it out
		</button>
	{/if}
</div>

<style>
	.scale {
		display: grid;
	}

	.effort {
		display: grid;
		gap: var(--space-3);
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}

	.row {
		display: flex;
		justify-content: space-between;
	}

	/* Paper: a 52 px circle, the numeral 19/24 in secondary; picked, the inverse fill in 600. */
	.numeral {
		position: relative;
		display: grid;
		place-items: center;
		width: 3.25rem;
		height: 3.25rem;
		border-radius: var(--radius-full);
		font: var(--type-button-lg);
		font-weight: var(--weight-regular);
		color: var(--color-text-secondary);
		transition: background-color var(--duration-fast) var(--ease-standard);
	}

	/* The native radio covers the circle: it is the hit area and the focus target. */
	.input {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		margin: 0;
		border-radius: inherit;
		appearance: none;
		opacity: 0;
		cursor: pointer;
	}

	.face {
		pointer-events: none;
		font-variant-numeric: lining-nums tabular-nums;
	}

	.numeral:has(.input:checked) {
		background: var(--color-surface-inverse);
		color: var(--color-text-inverse);
		font-weight: var(--weight-semibold);
	}

	.numeral:has(.input:focus-visible) {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	@media (hover: hover) and (pointer: fine) {
		.numeral:not(:has(.input:checked)):hover {
			background: var(--color-surface-2);
			color: var(--color-text);
		}
	}

	/* Paper: 13/18 tertiary at the ends, 16 px under the circles and 12 px in. */
	.ends {
		display: flex;
		justify-content: space-between;
		padding: var(--space-1) var(--space-3) 0;
		font: var(--type-caption);
		color: var(--color-text-tertiary);
	}

	.sentence {
		padding-top: var(--space-7);
		font: var(--type-secondary);
		color: var(--color-text-secondary);
	}

	.clear {
		justify-self: start;
		min-height: var(--touch-target);
		margin-top: var(--space-2);
		font: var(--type-secondary);
		color: var(--color-text-secondary);
		text-decoration: underline;
		text-underline-offset: 0.2em;
	}

	@media (hover: hover) and (pointer: fine) {
		.clear:hover {
			color: var(--color-text);
		}
	}
</style>
