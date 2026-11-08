<!--
  @component
  The coach's composer (PRD §12): the form named 'Message your coach', a message of up to 4,000
  characters that grows to eight lines, and Send, which turns into Stop while an answer runs.
  On a fine pointer Enter sends and Shift+Enter adds a newline; on a phone Return adds a newline
  (composer-keys.ts). Disabled, it keeps its shape and says why in its placeholder. Near the
  limit it shows its count. As `chrome` (the default) it is the screen's fixed chrome, centred
  over the content column and clear of the bottom bar or the rail (docs/design-system.md, Fixed
  and sticky chrome); /design shows it in place.
-->
<script lang="ts">
	import IconButton from '../components/IconButton.svelte';
	import {
		COMPOSER_MAX_CHARS,
		composerCount,
		pointerOf,
		sendsOnKey,
		type ComposerPointer
	} from './composer-keys.ts';

	interface Props {
		value?: string;
		placeholder?: string;
		/** Nothing can be sent: the coach is not available yet, or is switched off. */
		disabled?: boolean;
		/** An answer is running: Stop replaces Send. */
		running?: boolean;
		/** Fixed screen chrome (the coach screens), or in place (/design). */
		chrome?: boolean;
		onsend?: (text: string) => void;
		onstop?: () => void;
		'data-testid'?: string;
	}

	let {
		value = $bindable(''),
		placeholder = 'Ask your coach',
		disabled = false,
		running = false,
		chrome = true,
		onsend,
		onstop,
		'data-testid': testId
	}: Props = $props();

	const id = $props.id();
	// No pointer yet means the composer was reached from a keyboard.
	let pointer: ComposerPointer = 'fine';

	const count = $derived(composerCount(value));
	const sendable = $derived(!disabled && !running && value.trim().length > 0);

	function send() {
		if (sendable) onsend?.(value.trim());
	}

	function onkeydown(event: KeyboardEvent) {
		if (!sendsOnKey(event, pointer)) return;
		event.preventDefault();
		send();
	}
</script>

<form
	class="composer"
	class:chrome
	class:disabled
	aria-label="Message your coach"
	onpointerdown={(event) => (pointer = pointerOf(event.pointerType))}
	onsubmit={(event) => {
		event.preventDefault();
		send();
	}}
	data-testid={testId}
>
	<label class="visually-hidden" for={id}>Message</label>
	<textarea
		{id}
		class="input"
		rows="1"
		maxlength={COMPOSER_MAX_CHARS}
		{placeholder}
		{disabled}
		autocomplete="off"
		aria-describedby={count ? `${id}-count` : undefined}
		bind:value
		{onkeydown}></textarea>
	{#if count}
		<span class="count" id="{id}-count" data-testid="composer-count">
			<span class="visually-hidden">Characters used:</span>
			{count}
		</span>
	{/if}
	{#if running}
		<button type="button" class="stop" aria-label="Stop" onclick={() => onstop?.()}>
			<span class="square" aria-hidden="true"></span>
		</button>
	{:else}
		<IconButton icon="send" label="Send" variant="accent" type="submit" disabled={!sendable} />
	{/if}
</form>

<style>
	.composer {
		display: flex;
		align-items: flex-end;
		gap: var(--space-2);
		width: 100%;
		padding: var(--space-1-5) var(--space-1-5) var(--space-1-5) var(--space-4);
		border-radius: var(--radius-xl);
		background: var(--color-glass);
		backdrop-filter: saturate(180%) blur(32px);
		border: 1px solid var(--color-border);
		box-shadow: var(--elevation-2);
		transition:
			border-color var(--duration-fast) var(--ease-standard),
			box-shadow var(--duration-fast) var(--ease-standard);
	}

	/* Screen chrome: centred over the content column, clear of the bottom bar or the rail. */
	.chrome {
		position: fixed;
		z-index: var(--z-sticky);
		left: calc(50% + var(--nav-inset-left) / 2);
		transform: translateX(-50%);
		bottom: calc(var(--nav-inset-bottom) + var(--space-3));
		width: min(calc(100% - var(--nav-inset-left) - 2 * var(--gutter)), var(--content-column));
	}

	/* The ring is on the whole composer: the textarea is only its writing surface. */
	.composer:has(.input:focus-visible) {
		border-color: var(--color-accent);
		box-shadow:
			0 0 0 3px var(--color-accent-ring),
			var(--elevation-2);
	}

	.input {
		flex: 1;
		min-width: 0;
		min-height: var(--touch-target);
		/* One line centred in 44 px; eight lines at most, past them the message scrolls inside. */
		max-height: calc(7lh + var(--touch-target));
		padding: calc((var(--touch-target) - 1lh) / 2) 0;
		border: 0;
		background: transparent;
		/* ≥ 16px: iOS Safari zooms into smaller inputs on focus. */
		font-size: max(1rem, var(--text-base));
		line-height: var(--leading-snug);
		resize: none;
		field-sizing: content;
		overflow-y: auto;
	}

	.input:focus-visible {
		/* Forced colours drop the composer's shadow and draw this outline instead. */
		outline: 2px solid transparent;
	}

	.input::placeholder {
		color: var(--color-text-tertiary);
	}

	.disabled {
		background: color-mix(in srgb, var(--color-surface-2) 70%, var(--color-glass));
		border-style: dashed;
	}

	.input:disabled {
		cursor: not-allowed;
	}

	.count {
		flex: none;
		align-self: center;
		font-size: var(--text-xs);
		font-variant-numeric: tabular-nums;
		color: var(--color-text-secondary);
	}

	.stop {
		display: inline-grid;
		place-items: center;
		flex: none;
		width: var(--touch-target);
		height: var(--touch-target);
		border-radius: var(--radius-full);
		border: 1px solid var(--color-border-strong);
		background: var(--color-surface-2);
		color: var(--color-text);
		transition:
			transform var(--duration-fast) var(--ease-out),
			background-color var(--duration-fast) var(--ease-standard);
	}

	.square {
		width: 0.875rem;
		height: 0.875rem;
		border-radius: 3px;
		background: currentColor;
	}

	.stop:active {
		transform: scale(0.92);
		background: var(--color-surface-3);
		transition-duration: var(--duration-instant);
	}

	@media (hover: hover) and (pointer: fine) {
		.composer:not(.disabled):hover {
			border-color: var(--color-border-strong);
		}

		.stop:hover {
			background: var(--color-surface-3);
		}
	}
</style>
