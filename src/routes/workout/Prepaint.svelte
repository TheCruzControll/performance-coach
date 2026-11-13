<!--
  @component
  The current exercise, painted before the app starts (prepaint.ts): an empty, hidden container
  and, right after it, the inline script that builds the card this device kept into it and shows
  it, as the parser reaches it. The Shell renders it in the restoring skeleton's place, which it
  hides; once restored, the strength view's card replaces it where it stands.
  - Server-rendered only: hydration keeps the markup as it is (an {@html} block is never checked
    against the client's), and a client render (a later skeleton) gets the empty container alone,
    whose script would never run anyway. The CSP allows the script by its hash (vite.config.ts).
  - Its styles copy ExerciseCard's, SetRow's and the Button and IconButton the card uses, under
    .prepaint, so the card it draws has the hydrated one's boxes: the swap moves nothing
    (workout-prepaint.e2e.ts compares them). Change them together.
  - aria-hidden: the restoring status speaks for it; it has no controls, only their look.
  - From 1024 px it takes the view's columns: the card in the main one, the side list's left empty.
    With a rest shown (data-rest), whose timer sits above the card there, the skeleton stays.
-->
<script lang="ts">
	import { PREPAINT_SCRIPT } from '#lib/client/workout/prepaint.ts';
	import sprite from '#lib/ui/icons/sprite.svg?url&no-inline';

	const container = `<div class="prepaint" hidden aria-hidden="true" data-sprite="${sprite}"></div>`;
	// The script is in the server's build only: the client never runs or needs it. Its closing tag
	// is split, or it would end this block.
	const markup = import.meta.env.SSR
		? `${container}<script>${PREPAINT_SCRIPT}</${'script'}>`
		: container;
</script>

<!-- svelte-ignore hydration_html_changed -->
<!-- eslint-disable-next-line svelte/no-at-html-tags -- constant markup: no data reaches it -->
{@html markup}

<style>
	:global {
		.prepaint ol {
			list-style: none;
			margin: 0;
			padding: 0;
		}

		.prepaint .icon {
			flex: none;
			display: inline-block;
			vertical-align: middle;
			fill: none;
			stroke: currentColor;
			stroke-width: 1.75;
			stroke-linecap: round;
			stroke-linejoin: round;
		}

		/* ExerciseCard. */
		.prepaint .card {
			display: grid;
			gap: var(--space-4);
			padding: var(--space-4);
			border-radius: var(--radius-lg);
			border: 1px solid var(--color-border);
			background: var(--color-surface-1);
			box-shadow: var(--elevation-1);
		}

		.prepaint .head {
			display: grid;
			gap: var(--space-1);
		}

		.prepaint .place {
			display: flex;
			align-items: center;
			gap: var(--space-2);
			font-size: var(--text-sm);
			color: var(--color-text-secondary);
		}

		.prepaint .badge {
			display: inline-grid;
			place-items: center;
			min-width: 2rem;
			padding: var(--space-0-5) var(--space-1-5);
			border-radius: var(--radius-full);
			background: color-mix(in srgb, var(--color-strength) 16%, transparent);
			color: var(--color-text);
			font-size: var(--text-xs);
			font-weight: var(--weight-semibold);
		}

		.prepaint .title {
			display: flex;
			align-items: flex-start;
			justify-content: space-between;
			gap: var(--space-2);
		}

		.prepaint .head > .state {
			display: flex;
			flex-wrap: wrap;
			gap: var(--space-1) var(--space-2);
			font-size: var(--text-sm);
			color: var(--color-text-secondary);
		}

		.prepaint .head > .state strong {
			color: var(--color-accent-text);
			font-weight: var(--weight-semibold);
		}

		.prepaint h2 {
			flex: 1;
			min-width: 0;
			font-family: var(--font-display);
			font-size: var(--text-2xl);
			font-weight: var(--weight-bold);
			letter-spacing: var(--tracking-tight);
			line-height: var(--leading-snug);
			overflow-wrap: anywhere;
		}

		.prepaint .history {
			display: inline-flex;
			align-items: center;
			gap: var(--space-1);
			min-height: var(--touch-target);
			text-align: start;
		}

		.prepaint .target {
			display: grid;
			gap: var(--space-1-5);
		}

		.prepaint .stack {
			display: grid;
			align-items: start;
		}

		.prepaint .stack:not(:has(p)) {
			display: none;
		}

		.prepaint .stack > * {
			grid-area: 1 / 1;
		}

		.prepaint .ghost {
			visibility: hidden;
		}

		.prepaint .ghost::before {
			content: attr(data-text);
		}

		.prepaint .lines {
			font-size: var(--text-lg);
			font-weight: var(--weight-semibold);
			line-height: var(--leading-snug);
		}

		.prepaint .load {
			color: var(--color-text-secondary);
			line-height: var(--leading-normal);
		}

		.prepaint .load[data-kind='weight'] {
			font-family: var(--font-numeric);
			font-size: var(--text-3xl);
			font-weight: var(--weight-bold);
			color: var(--color-text);
			font-variant-numeric: lining-nums proportional-nums;
		}

		.prepaint .target .rest {
			font-size: var(--text-sm);
			color: var(--color-text-secondary);
		}

		.prepaint .previous {
			display: grid;
			gap: var(--space-2);
			padding-top: var(--space-3);
			border-top: 1px solid var(--color-hairline);
		}

		.prepaint h3 {
			font-size: var(--text-sm);
			font-weight: var(--weight-semibold);
			color: var(--color-text-secondary);
		}

		.prepaint .chips {
			display: flex;
			flex-wrap: wrap;
			gap: var(--space-1-5);
		}

		.prepaint .chips li {
			padding: var(--space-1) var(--space-2);
			border-radius: var(--radius-sm);
			background: var(--color-surface-2);
			font-size: var(--text-sm);
			overflow-wrap: anywhere;
		}

		.prepaint .sets {
			display: grid;
			gap: var(--space-1);
		}

		/* Button: secondary, md (the card's Options). */
		.prepaint .btn {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			gap: var(--space-2);
			min-height: 3rem;
			padding: 0 var(--space-5);
			border-radius: var(--radius-full);
			border: 1px solid var(--color-border);
			background: var(--color-surface-2);
			box-shadow: inset 0 1px 0 0 var(--color-highlight);
			color: var(--color-text);
			font-family: var(--font-sans);
			font-size: var(--text-base);
			font-weight: var(--weight-semibold);
			letter-spacing: var(--tracking-tight);
			line-height: 1;
			white-space: nowrap;
		}

		.prepaint .label {
			display: inline-flex;
			align-items: center;
		}

		/* SetRow, and its plate button (IconButton, ghost, md). */
		.prepaint .sets > li {
			display: flex;
			align-items: center;
			gap: var(--space-1);
		}

		.prepaint .set {
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

		.prepaint .plated .set {
			grid-template-columns: 1rem minmax(0, 1fr) auto;
			column-gap: var(--space-2);
			padding-inline: var(--space-2);
		}

		.prepaint .set.edit {
			border-color: var(--color-hairline);
		}

		.prepaint .index {
			color: var(--color-text-tertiary);
			font-size: var(--text-sm);
		}

		.prepaint .set .text {
			overflow-wrap: anywhere;
			color: var(--color-text-secondary);
		}

		.prepaint .set .state {
			display: inline-flex;
			align-items: center;
			gap: var(--space-1);
			min-width: 2.75rem;
			font-size: var(--text-sm);
			color: var(--color-text-tertiary);
		}

		.prepaint [data-state='current'] .set {
			border-color: var(--color-accent);
			background: var(--color-surface-2);
		}

		.prepaint [data-state='current'] .text,
		.prepaint [data-state='done'] .text,
		.prepaint [data-state='missed'] .text,
		.prepaint [data-state='extra'] .text {
			color: var(--color-text);
			font-weight: var(--weight-medium);
		}

		.prepaint [data-state='current'] .set .state {
			color: var(--color-accent-text);
			font-weight: var(--weight-semibold);
		}

		.prepaint [data-state='done'] .set .state {
			color: var(--color-positive);
		}

		.prepaint [data-state='done'] .set .state::before {
			content: '';
			width: 0.4rem;
			height: 0.8rem;
			margin: 0 0.3rem 0.2rem;
			border: solid currentColor;
			border-width: 0 2px 2px 0;
			transform: rotate(45deg);
		}

		.prepaint [data-state='done'] .set .state > span {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip-path: inset(50%);
			white-space: nowrap;
		}

		.prepaint [data-state='missed'] .set .state {
			color: var(--color-warning);
		}

		.prepaint [data-state='not-saved'] .set .state {
			color: var(--color-danger);
			font-weight: var(--weight-semibold);
		}

		.prepaint .plate {
			display: inline-grid;
			place-items: center;
			flex: none;
			width: var(--touch-target);
			height: var(--touch-target);
			border-radius: var(--radius-full);
			border: 1px solid transparent;
			color: var(--color-text);
		}
	}

	/* The skeleton it replaces. */
	@media (width < 64rem) {
		:global(.prepaint:not([hidden]) ~ *) {
			display: none;
		}
	}

	/* The view's columns (Shell.svelte): the card where the main column's starts, under the rest
	   timer's kept place and the column's gap (StrengthView.svelte; change them together). A rest's
	   timer sits above it there, so with a rest shown the skeleton stays instead. */
	@media (width >= 64rem) {
		:global(.prepaint:not([hidden]):not([data-rest]) ~ *) {
			display: none;
		}

		:global(.prepaint[data-rest]) {
			display: none;
		}

		:global(.prepaint:not([hidden], [data-rest])) {
			display: grid;
			grid-template-columns: var(--content-list) minmax(0, var(--content-readable));
			justify-content: center;
			align-items: start;
			gap: var(--space-8);
		}

		:global(.prepaint > .card) {
			grid-column: 2;
			margin-top: calc(
				2 * var(--space-3) + 2px + var(--text-2xs) * var(--leading-normal) + var(--text-3xl) *
					var(--leading-tight) + var(--space-2) + 4px + var(--space-4)
			);
		}
	}
</style>
