<!--
  @component
  Inline message about the screen's state: an error to act on, a success, a caution. Instrument
  v2 (Paper, 10 · States): no box and no glyph. An error is one red line (its title, or its words
  when it has none); the rest are plain lines whose words say what happened (amber is only ever
  the next thing to do, so a caution is not amber). Errors are announced (role="alert"), the rest
  politely (role="status").
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { IconName } from '../icons/icons';

	type Tone = 'danger' | 'positive' | 'warning' | 'neutral';

	interface Props {
		tone?: Tone;
		/** @deprecated v2 notices have no glyph: accepted and not drawn. */
		icon?: IconName;
		title?: string;
		'data-testid'?: string;
		children: Snippet;
	}

	let { tone = 'neutral', icon: _icon, title, 'data-testid': testId, children }: Props = $props();
</script>

<div
	class="notice"
	data-tone={tone}
	role={tone === 'danger' ? 'alert' : 'status'}
	data-testid={testId}
>
	{#if title}<p class="title">{title}</p>{/if}
	<div class="message">{@render children()}</div>
</div>

<style>
	.notice {
		--tone: var(--color-text);
		display: grid;
		gap: var(--space-1);
		min-width: 0;
	}

	.notice[data-tone='danger'] {
		--tone: var(--color-danger);
	}

	.title {
		font: var(--type-secondary);
		color: var(--tone);
	}

	.message {
		font: var(--type-secondary);
		color: var(--color-text-secondary);
	}

	/* With no title, the words are the line: an error's in red. */
	.notice[data-tone='danger'] .message:first-child {
		color: var(--tone);
	}

	.message :global(a) {
		color: var(--color-text);
		font-weight: var(--weight-semibold);
		text-decoration: underline;
		text-decoration-thickness: 1px;
		text-underline-offset: 4px;
	}
</style>
