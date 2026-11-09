<!--
  @component
  A trend verdict in words plus an icon: 'Real improvement', 'Real decline', 'Normal variation' or
  'Not enough data yet · 2 of 6 weeks', with 'over the last 12 weeks' when the verdict reads other
  weeks than the period's (words.ts). The words carry the meaning; the tone only reinforces it.
  Sentence case and free to wrap, unlike Badge, so the longest verdict fits a tile at 320 px.
-->
<script lang="ts">
	import Icon from '../components/Icon.svelte';
	import {
		verdictIcon,
		verdictTone,
		verdictWords,
		type TileVerdict,
		type VerdictWindow
	} from './words.ts';

	interface Props {
		verdict: TileVerdict;
		window?: VerdictWindow;
		/** Hidden from screen readers when a sentence around it already says it (TrendTile). */
		'aria-hidden'?: 'true';
	}

	let { verdict, window, ...rest }: Props = $props();
</script>

<span class="verdict" data-tone={verdictTone(verdict)} data-testid="verdict" {...rest}>
	<span class="glyph"><Icon name={verdictIcon(verdict)} size={14} strokeWidth={2} /></span>
	<span>{verdictWords(verdict, window)}</span>
</span>

<style>
	.verdict {
		--verdict-text: var(--color-text-secondary);
		--verdict-bg: var(--color-surface-2);
		display: inline-flex;
		justify-self: start;
		align-items: flex-start;
		gap: var(--space-1-5);
		max-width: 100%;
		padding: var(--space-1) var(--space-2) var(--space-1) var(--space-1-5);
		border-radius: var(--radius-sm);
		background: var(--verdict-bg);
		color: var(--verdict-text);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
		line-height: 1.3;
	}

	.glyph {
		display: inline-flex;
		flex: none;
		/* The icon centred on the first line of words, however many lines they wrap to. */
		height: 1.3em;
		align-items: center;
	}

	/* As Badge: status text darkened on its tint in the light theme to keep ≥ 4.5:1. */
	.verdict[data-tone='positive'] {
		--verdict-text: light-dark(
			color-mix(in srgb, var(--color-positive) 82%, #000),
			var(--color-positive)
		);
		--verdict-bg: color-mix(in srgb, var(--color-positive) 12%, transparent);
	}

	.verdict[data-tone='warning'] {
		--verdict-text: light-dark(
			color-mix(in srgb, var(--color-warning) 82%, #000),
			var(--color-warning)
		);
		--verdict-bg: color-mix(in srgb, var(--color-warning) 12%, transparent);
	}
</style>
