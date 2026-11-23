<!--
  @component
  A tappable row for tools and destinations (Instrument v2): a title, one line of supporting
  text, an optional trailing value and a chevron (or a `trailing` snippet such as a "Soon"
  badge). A hairline sits under each row but a list's last. Renders a link with `href`, a button
  with `onclick`, a static row when `disabled` (not yet available), or a status row with `static`
  (a fact, "Backups · 6 h ago": no chevron, full contrast). `danger` draws the title in
  the danger colour with no chevron ("Sign out"). Full-width, at least 60 px tall: an easy thumb
  target.
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { IconName } from '../icons/icons';
	import Icon from './Icon.svelte';

	type Tone = 'accent' | 'strength' | 'running' | 'combat' | 'hypertrophy' | 'conditioning';

	interface Props {
		title: string;
		subtitle?: string;
		/**
		 * @deprecated v2 rows have no icon tiles: the icon is accepted and not drawn. Removed when
		 * the last screen row drops it.
		 */
		icon?: IconName;
		/** @deprecated Only the icon tile used it, and v2 rows have none. Accepted and not drawn. */
		tone?: Tone;
		/** The trailing value text ("kg, km", "3"), before the chevron. */
		value?: string;
		/** `warning` draws the value in the warning colour; its words must say why on their own. */
		valueTone?: 'warning';
		/** A status row: no action and no chevron, at full contrast (unlike `disabled`). */
		static?: boolean;
		/** The title in the danger colour, with no chevron ("Sign out"). */
		danger?: boolean;
		href?: string;
		onclick?: (event: MouseEvent) => void;
		/** Shown but not actionable yet; pair with a "Soon" badge in `trailing`. */
		disabled?: boolean;
		trailing?: Snippet;
		onpointerdown?: (event: PointerEvent) => void;
		onpointerenter?: (event: PointerEvent) => void;
		/** The destination open beside a list of rows (a section beside its editor). */
		'aria-current'?: 'page';
		/** A status row whose value is still loading (a Skeleton in `trailing`). */
		'aria-busy'?: boolean;
		'data-testid'?: string;
	}

	let {
		title,
		subtitle,
		icon: _icon,
		tone: _tone,
		value,
		valueTone,
		static: isStatic = false,
		danger = false,
		href,
		onclick,
		disabled = false,
		trailing,
		...rest
	}: Props = $props();
</script>

{#snippet body()}
	<span class="text">
		<span class="title">{title}</span>
		{#if subtitle}<span class="subtitle">{subtitle}</span>{/if}
	</span>
	{#if value}<span class="value" data-tone={valueTone}>{value}</span>{/if}
	{#if trailing}{@render trailing()}{:else if !(disabled || danger || isStatic)}<span
			class="chevron"><Icon name="chevron-right" size={14} /></span
		>{/if}
{/snippet}

{#if disabled || isStatic}
	<div
		class="row"
		aria-disabled={disabled ? 'true' : undefined}
		data-danger={danger ? '' : undefined}
		{...rest}
	>
		{@render body()}
	</div>
{:else if href}
	<a class="row interactive" {href} data-danger={danger ? '' : undefined} {...rest}>
		{@render body()}
	</a>
{:else}
	<button
		type="button"
		class="row interactive"
		{onclick}
		data-danger={danger ? '' : undefined}
		{...rest}
	>
		{@render body()}
	</button>
{/if}

<style>
	.row {
		display: flex;
		align-items: center;
		gap: var(--space-3-5);
		width: 100%;
		min-height: 3.75rem;
		padding: var(--space-2) 0;
		border: 0;
		border-radius: var(--radius-sm);
		border-bottom: 1px solid var(--color-hairline);
		background: transparent;
		box-shadow: none;
		color: var(--color-text);
		text-align: left;
	}

	/* The last row of a list has no hairline. A row is last when nothing follows it in its
	   parent; in a list item (li) it is last when its item is the list's last item. */
	.row:last-child {
		border-bottom-color: transparent;
	}

	:global(li) > .row:last-child {
		border-bottom-color: var(--color-hairline);
	}

	:global(li:last-child) > .row {
		border-bottom-color: transparent;
	}

	.interactive {
		cursor: pointer;
	}

	/* The tint reaches 8 px past the text (the box-shadow spread), so it never moves the layout. */
	.interactive:active {
		background: var(--color-surface-2);
		box-shadow: 0 0 0 var(--space-2) var(--color-surface-2);
	}

	@media (hover: hover) and (pointer: fine) {
		.interactive:hover {
			background: var(--color-surface-2);
			box-shadow: 0 0 0 var(--space-2) var(--color-surface-2);
		}
	}

	/* The open destination: a tint, and aria-current says it too. */
	.row[aria-current='page'] {
		background: var(--color-surface-2);
		box-shadow: 0 0 0 var(--space-2) var(--color-surface-2);
	}

	.text {
		flex: 1;
		display: grid;
		min-width: 0;
	}

	.title {
		font: var(--type-row);
	}

	.row[aria-current='page'] .title {
		font-weight: var(--weight-semibold);
	}

	.subtitle {
		font: var(--type-secondary);
		color: var(--color-text-secondary);
	}

	.value {
		flex: none;
		font: var(--type-secondary);
		color: var(--color-text-secondary);
		font-variant-numeric: tabular-nums;
	}

	.value[data-tone='warning'] {
		color: var(--color-warning);
	}

	.chevron {
		display: grid;
		color: var(--color-text-tertiary);
	}

	.row[data-danger] .title {
		color: var(--color-danger);
	}

	/* Not available yet: quieter, without lowering text contrast below 4.5:1. */
	.row[aria-disabled='true'] {
		border-style: solid;
	}

	.row[aria-disabled='true'] .title {
		color: var(--color-text-secondary);
	}
</style>
