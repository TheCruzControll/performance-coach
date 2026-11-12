<!--
  @component
  One metric at a glance: label, a big value with an optional inline unit, an optional rating
  and a caption. Every metric tile in the app is this component, so values, units and empty
  states look identical on every screen. A missing value renders a quiet dash (announced as
  "no data yet"), never an invented number (PRD §12).

  A rating is a word plus a coloured dot: the word carries the meaning, the dot reinforces it.
-->
<script lang="ts">
	interface Props {
		label: string;
		value?: string | number | null;
		/** Shown after the value (e.g. "ms", "kg"); omitted while there is no value. */
		unit?: string;
		/** Small line under the value: period, sample count, or the unit while empty. */
		caption?: string;
		rating?: { tone: 'positive' | 'warning' | 'danger'; label: string };
		/** 1 = tile on the canvas (28 px value); 2 = compact, nested inside a card (22 px). */
		level?: 1 | 2;
		/**
		 * Steps a level-1 value down to the compact size when its tile is too narrow for it
		 * ('1 h 00 min' two to a row on a phone). For a tile sized by its grid, never by its words.
		 */
		fit?: boolean;
		as?: 'div' | 'li';
		'data-testid'?: string;
	}

	let {
		label,
		value = null,
		unit,
		caption,
		rating,
		level = 1,
		fit = false,
		as = 'div',
		...rest
	}: Props = $props();

	const empty = $derived(value === null || value === '');
</script>

<svelte:element this={as} class="stat" data-level={level} data-fit={fit || undefined} {...rest}>
	<span class="label">{label}</span>
	<span class="value numeric" class:empty>
		{#if empty}
			<span aria-hidden="true">—</span><span class="visually-hidden">No data yet</span>
		{:else}
			{value}{#if unit}<span class="unit">{unit}</span>{/if}
		{/if}
	</span>
	{#if rating}
		<span class="rating" data-tone={rating.tone}>
			<span class="dot" aria-hidden="true"></span>{rating.label}
		</span>
	{/if}
	{#if caption}<span class="caption">{caption}</span>{/if}
</svelte:element>

<style>
	.stat {
		display: grid;
		align-content: start;
		gap: var(--space-1);
		min-width: 0;
		padding: var(--space-4);
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-border);
		background: var(--color-surface-1);
		box-shadow: var(--elevation-1);
	}

	.stat[data-level='2'] {
		padding: var(--space-3);
		border-radius: var(--radius-md);
		background: var(--color-surface-2);
		box-shadow: none;
	}

	.label {
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
	}

	.value {
		margin-top: var(--space-1);
		font-size: var(--text-2xl);
		font-weight: var(--weight-bold);
		line-height: 1;
		color: var(--color-text);
		white-space: nowrap;
	}

	/* Nested tiles sit three to a row inside a card: the compact step of the same scale. */
	.stat[data-level='2'] .value {
		font-size: var(--text-xl);
	}

	.value.empty {
		color: var(--color-text-tertiary);
	}

	/* A fitted tile measures its own width (its grid sets it), and its value steps down in one. */
	.stat[data-fit] {
		container-type: inline-size;
	}

	@container (width < 8.5rem) {
		.stat[data-fit] .value {
			font-size: var(--text-xl);
		}
	}

	.unit {
		margin-left: 0.15em;
		font-family: var(--font-sans);
		font-size: var(--text-xs);
		font-weight: var(--weight-medium);
		letter-spacing: var(--tracking-normal);
		color: var(--color-text-tertiary);
	}

	.rating {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1-5);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
		color: var(--color-text-secondary);
	}

	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--rating-color);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--rating-color) 20%, transparent);
	}

	.rating[data-tone='positive'] {
		--rating-color: var(--color-positive);
	}
	.rating[data-tone='warning'] {
		--rating-color: var(--color-warning);
	}
	.rating[data-tone='danger'] {
		--rating-color: var(--color-danger);
	}

	.caption {
		font-size: var(--text-2xs);
		color: var(--color-text-tertiary);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
	}
</style>
