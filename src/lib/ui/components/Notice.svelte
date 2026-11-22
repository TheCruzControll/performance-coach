<!--
  @component
  Inline message about the screen's state: an error to act on, a success, a caution. Tinted,
  with an icon and words (never colour alone). Errors are announced (role="alert"), the rest
  politely (role="status").
-->
<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { IconName } from '../icons/icons';
	import Icon from './Icon.svelte';

	type Tone = 'danger' | 'positive' | 'warning' | 'neutral';

	interface Props {
		tone?: Tone;
		icon?: IconName;
		title?: string;
		'data-testid'?: string;
		children: Snippet;
	}

	const ICONS: Record<Tone, IconName> = {
		danger: 'alert',
		positive: 'check',
		warning: 'alert',
		neutral: 'info'
	};

	let { tone = 'neutral', icon, title, 'data-testid': testId, children }: Props = $props();
</script>

<div
	class="notice"
	data-tone={tone}
	role={tone === 'danger' ? 'alert' : 'status'}
	data-testid={testId}
>
	<span class="glyph"><Icon name={icon ?? ICONS[tone]} size={18} /></span>
	<div class="text">
		{#if title}<p class="title">{title}</p>{/if}
		<div class="message">{@render children()}</div>
	</div>
</div>

<style>
	.notice {
		--tone: var(--color-text-secondary);
		display: flex;
		align-items: flex-start;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--tone) 30%, transparent);
		background: color-mix(in srgb, var(--tone) 9%, var(--color-surface-1));
	}

	.notice[data-tone='danger'] {
		--tone: var(--color-danger);
	}
	.notice[data-tone='positive'] {
		--tone: var(--color-positive);
	}
	.notice[data-tone='warning'] {
		--tone: var(--color-warning);
	}

	.glyph {
		display: grid;
		flex: none;
		margin-top: 1px;
		color: var(--tone);
	}

	.text {
		display: grid;
		gap: var(--space-0-5);
		min-width: 0;
	}

	.title {
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
	}

	.message {
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
		color: var(--color-text-secondary);
	}

	.message :global(a) {
		color: var(--color-accent-text);
		text-decoration: underline;
		text-underline-offset: 2px;
	}
</style>
