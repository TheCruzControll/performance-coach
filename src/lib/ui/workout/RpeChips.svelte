<!--
  @component
  The set's RPE (PRD §8): one chip per value of RPE_CHIPS, 6 to 10 in halves, then 'No RPE', in
  two rows. Native radios in a fieldset, so the group is one Tab stop, the arrow keys move the
  choice within it, and screen readers hear a radio group. Every chip is at least 44 px, and the
  chosen one shows a tick beside its accent ring, never colour alone.
-->
<script lang="ts">
	interface Props {
		/** The values offered (prefill.ts's RPE_CHIPS), in order. */
		chips: readonly number[];
		/** null: 'No RPE'. */
		value: number | null;
		onchange: (value: number | null) => void;
	}

	let { chips, value, onchange }: Props = $props();

	const id = $props.id();
	const options = $derived([
		...chips.map((chip) => ({ value: chip as number | null, label: String(chip) })),
		{ value: null, label: 'No RPE' }
	]);
</script>

<fieldset class="rpe" data-testid="rpe-chips">
	<legend class="legend">RPE</legend>
	<div class="chips">
		{#each options as option (option.label)}
			<label class="chip">
				<!-- `checked` through a spread, as ChoiceGroup does: no extra runtime helper. -->
				<input
					class="input"
					type="radio"
					name={id}
					value={option.label}
					{...{ checked: value === option.value }}
					onchange={() => onchange(option.value)}
				/>
				<span class="face">
					<span class="tick" aria-hidden="true"></span>
					<span class="label tabular">{option.label}</span>
				</span>
			</label>
		{/each}
	</div>
</fieldset>

<style>
	.rpe {
		min-width: 0;
		margin: 0;
		padding: 0;
		border: 0;
	}

	.legend {
		margin-bottom: var(--space-2);
		padding: 0;
		font-size: var(--text-2xs);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
		color: var(--color-text-tertiary);
	}

	.chips {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		gap: var(--space-2);
	}

	.chip {
		position: relative;
		display: flex;
		min-width: 0;
	}

	/* The native radio covers the chip: it is the hit area and the focus target. */
	.input {
		position: absolute;
		inset: 0;
		z-index: 1;
		width: 100%;
		height: 100%;
		margin: 0;
		appearance: none;
		opacity: 0;
		cursor: pointer;
	}

	.face {
		position: relative;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		min-height: var(--touch-target);
		padding: var(--space-1);
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		background: var(--color-surface-2);
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		text-align: center;
		transition:
			background-color var(--duration-fast) var(--ease-standard),
			border-color var(--duration-fast) var(--ease-standard),
			transform var(--duration-fast) var(--ease-out);
	}

	.label {
		min-width: 0;
		overflow-wrap: anywhere;
	}

	.input:checked + .face {
		border-color: var(--color-accent);
		background: var(--color-accent-subtle);
		color: var(--color-text);
	}

	.input:focus-visible + .face {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	.input:active + .face {
		transform: scale(0.96);
	}

	/*
	 * A drawn tick (no icon in the bundle) in the chosen chip's corner, out of the text's way, so
	 * choosing a chip never changes its size.
	 */
	.tick {
		display: none;
		position: absolute;
		top: var(--space-1-5);
		right: var(--space-2);
		width: 0.25rem;
		height: 0.5rem;
		border: solid var(--color-accent-text);
		border-width: 0 2px 2px 0;
		transform: rotate(45deg);
	}

	.input:checked + .face .tick {
		display: block;
	}

	@media (hover: hover) and (pointer: fine) {
		.input:not(:checked):hover + .face {
			border-color: var(--color-border-strong);
			background: var(--color-surface-3);
		}
	}
</style>
