<!--
  @component
  Big, one-handed numeric control for gym use: oversized −/+ targets, press-and-hold to repeat
  (accelerating), tap the value to type (Enter commits, Escape cancels the edit without closing
  an enclosing sheet), ArrowUp/ArrowDown/PageUp/PageDown/Home/End on the keyboard. Exposed to
  assistive tech as a spinbutton; an error marks it invalid and is announced in place of the hint.
  `format` and `parse` show and read the value another way (seconds as m:ss).
-->
<script lang="ts">
	import IconButton from './IconButton.svelte';

	interface Props {
		value: number;
		label: string;
		min?: number;
		max?: number;
		step?: number;
		/** Larger jump for PageUp/PageDown. */
		bigStep?: number;
		unit?: string;
		/** Decimal places shown; defaults to the precision of `step`. */
		decimals?: number;
		hint?: string;
		/** Replaces the hint while shown. */
		error?: string | null;
		/** The value as shown and typed, instead of the number: seconds as '1:30'. */
		format?: (value: number) => string;
		/** Reads what was typed back; NaN or null keeps the value. Number() by default. */
		parse?: (text: string) => number | null;
		onchange?: (value: number) => void;
		'data-testid'?: string;
	}

	let {
		value = $bindable(),
		label,
		min = 0,
		max = 9999,
		step = 1,
		bigStep,
		unit,
		decimals,
		hint,
		error = null,
		format,
		parse,
		onchange,
		'data-testid': testId
	}: Props = $props();

	const id = $props.id();
	// Only the message on screen describes the value: the error replaces the hint.
	const describedBy = $derived(error ? `${id}-error` : hint ? `${id}-hint` : undefined);
	const places = $derived(decimals ?? String(step).split('.')[1]?.length ?? 0);
	// Plain string formatting on purpose: creating an Intl formatter during hydration costs
	// ~15–20 ms on a phone-class CPU (measured), which shows up as Total Blocking Time.
	const display = $derived(format ? format(value) : String(Number(value.toFixed(places))));

	let editing = $state(false);
	let draft = $state('');

	function clampRound(next: number): number {
		const snapped = Math.round(next / step) * step;
		const fixed = Number(snapped.toFixed(Math.max(places, 6)));
		return Math.min(max, Math.max(min, Number(fixed.toFixed(places))));
	}

	function set(next: number) {
		const v = clampRound(next);
		if (v !== value) {
			value = v;
			onchange?.(v);
		}
	}

	// ---- press-and-hold repeat -------------------------------------------------------
	let holdTimer: ReturnType<typeof setTimeout> | undefined;
	let repeated = false;

	function startHold(direction: 1 | -1) {
		stopHold();
		repeated = false;
		let delay = 380;
		const tick = () => {
			repeated = true;
			set(value + direction * step);
			// Stop at the bounds: a disabled button never receives the pointerup.
			if ((direction > 0 && value >= max) || (direction < 0 && value <= min)) return stopHold();
			delay = Math.max(45, delay * 0.78);
			holdTimer = setTimeout(tick, delay);
		};
		holdTimer = setTimeout(tick, delay);
		window.addEventListener('pointerup', stopHold, { once: true });
		window.addEventListener('pointercancel', stopHold, { once: true });
	}

	function stopHold() {
		clearTimeout(holdTimer);
		holdTimer = undefined;
	}

	function tap(direction: 1 | -1) {
		// A hold already applied its steps; swallow the trailing click.
		if (repeated) {
			repeated = false;
			return;
		}
		set(value + direction * step);
	}

	$effect(() => stopHold);

	// ---- keyboard + direct entry -------------------------------------------------------
	function onkeydown(event: KeyboardEvent) {
		const big = bigStep ?? step * 10;
		const actions: Record<string, () => void> = {
			ArrowUp: () => set(value + step),
			ArrowDown: () => set(value - step),
			PageUp: () => set(value + big),
			PageDown: () => set(value - big),
			Home: () => set(min),
			End: () => set(max)
		};
		const action = actions[event.key];
		if (action) {
			event.preventDefault();
			if (editing) commit();
			action();
		} else if (event.key === 'Enter') {
			commit();
			(event.currentTarget as HTMLInputElement).blur();
		} else if (event.key === 'Escape' && editing) {
			// Cancel typing only. Inside a modal <dialog> (BottomSheet) Escape is also the dialog's
			// close request; a canceled keydown is not one, so the sheet stays open.
			event.preventDefault();
			event.stopPropagation();
			editing = false;
			(event.currentTarget as HTMLInputElement).blur();
		}
	}

	function onfocus(event: FocusEvent) {
		editing = true;
		draft = display;
		const input = event.currentTarget as HTMLInputElement;
		// Select after the browser has placed the caret. Only while still editing this field:
		// select() also focuses the input, so a frame that lands after Enter/Escape/blur (slow
		// devices, busy CI) would otherwise pull focus back into a field the user just left.
		requestAnimationFrame(() => {
			if (editing && document.activeElement === input) input.select();
		});
	}

	function commit() {
		if (!editing) return;
		editing = false;
		const parsed = parse ? parse(draft) : Number(draft.replace(',', '.'));
		if (draft.trim() !== '' && parsed !== null && Number.isFinite(parsed)) set(parsed);
	}
</script>

<div class="stepper" class:invalid={Boolean(error)} data-testid={testId}>
	<label class="label" for={id}>{label}</label>
	<div class="row">
		<IconButton
			icon="minus"
			label={`Decrease ${label}`}
			variant="filled"
			size="lg"
			disabled={value <= min}
			onclick={() => tap(-1)}
			onpointerdown={(e) => e.button === 0 && startHold(-1)}
			onpointerup={stopHold}
			onpointerleave={stopHold}
			onpointercancel={stopHold}
		/>
		<div class="value-wrap">
			<input
				{id}
				class="value numeric"
				type="text"
				inputmode="decimal"
				autocomplete="off"
				enterkeyhint="done"
				role="spinbutton"
				aria-valuenow={value}
				aria-valuemin={min}
				aria-valuemax={max}
				aria-valuetext={unit ? `${display} ${unit}` : display}
				aria-invalid={error ? 'true' : undefined}
				aria-describedby={describedBy}
				value={editing ? draft : display}
				style:width={`calc(${Math.max(2, (editing ? draft : display).length)}ch + 0.25em)`}
				oninput={(e) => (draft = e.currentTarget.value)}
				{onfocus}
				onblur={commit}
				{onkeydown}
			/>
			{#if unit}<span class="unit" aria-hidden="true">{unit}</span>{/if}
		</div>
		<IconButton
			icon="plus"
			label={`Increase ${label}`}
			variant="filled"
			size="lg"
			disabled={value >= max}
			onclick={() => tap(1)}
			onpointerdown={(e) => e.button === 0 && startHold(1)}
			onpointerup={stopHold}
			onpointerleave={stopHold}
			onpointercancel={stopHold}
		/>
	</div>
	{#if error}
		<p id="{id}-error" class="hint error" role="alert">{error}</p>
	{:else if hint}
		<p id="{id}-hint" class="hint">{hint}</p>
	{/if}
</div>

<style>
	.stepper {
		display: grid;
		gap: var(--space-2);
	}

	.label {
		font-size: var(--text-2xs);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
		color: var(--color-text-tertiary);
		text-align: center;
	}

	.row {
		display: grid;
		grid-template-columns: auto 1fr auto;
		align-items: center;
		gap: var(--space-3);
	}

	.value-wrap {
		display: flex;
		align-items: baseline;
		justify-content: center;
		gap: var(--space-1-5);
		min-width: 0;
	}

	.value {
		min-width: 0;
		max-width: 100%;

		padding: var(--space-1) 0;
		background: transparent;
		border: 0;
		border-radius: var(--radius-sm);
		color: var(--color-text);
		font-family: var(--font-numeric);
		font-variant-numeric: lining-nums proportional-nums;
		font-size: var(--text-5xl);
		font-weight: var(--weight-bold);
		line-height: 1;
		letter-spacing: var(--tracking-display);
		text-align: center;
		caret-color: var(--color-accent);
	}

	.value:focus-visible {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
		background: var(--color-surface-2);
	}

	.unit {
		font-size: var(--text-lg);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
	}

	.hint {
		font-size: var(--text-sm);
		color: var(--color-text-tertiary);
		text-align: center;
	}

	.invalid .value,
	.error {
		color: var(--color-danger);
	}
</style>
