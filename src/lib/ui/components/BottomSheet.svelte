<!--
  @component
  Modal bottom sheet built on the native <dialog> (showModal): focus is trapped and the page
  behind is inert by the platform itself; Escape and backdrop tap close; focus returns to the
  opener. Drag the handle/header down to dismiss (distance or velocity threshold).
-->
<script lang="ts">
	import { onDestroy, type Snippet } from 'svelte';
	import { lockScroll } from '../scroll-lock.ts';
	import IconButton from './IconButton.svelte';

	interface Props {
		open: boolean;
		title: string;
		description?: string;
		onclose?: () => void;
		footer?: Snippet;
		'data-testid'?: string;
		children: Snippet;
	}

	let {
		open = $bindable(),
		title,
		description,
		onclose,
		footer,
		'data-testid': testId,
		children
	}: Props = $props();

	const id = $props.id();
	let dialog: HTMLDialogElement | undefined = $state();
	let sheet: HTMLDivElement | undefined = $state();
	let visible = $state(false);
	// Content is mounted only while the sheet is open (or animating out): a closed sheet
	// costs nothing at hydration.
	let mounted = $state(false);
	let dragY = $state(0);
	let dragging = $state(false);
	let opener: HTMLElement | null = null;
	let releaseScroll: (() => void) | null = null;

	$effect(() => {
		if (open) show();
		else void hide();
	});

	// Teardown while open (e.g. navigating Back with the sheet up): hide() never runs, so
	// release the page scroll lock and close the dialog here.
	onDestroy(() => {
		releaseScroll?.();
		releaseScroll = null;
		if (dialog?.open) dialog.close();
	});

	function show() {
		if (!dialog || dialog.open) return;
		opener = document.activeElement as HTMLElement | null;
		dragY = 0;
		mounted = true;
		dialog.showModal();
		// Start focus on the sheet itself (announced via aria-labelledby), not the close button.
		sheet?.focus({ preventScroll: true });
		releaseScroll ??= lockScroll();
		requestAnimationFrame(() => (visible = true));
	}

	async function hide() {
		if (!dialog?.open) return;
		visible = false;
		await transitionDone();
		dialog.close();
		mounted = false;
		releaseScroll?.();
		releaseScroll = null;
		dragY = 0;
		if (opener?.isConnected) opener.focus({ preventScroll: true });
	}

	function transitionDone(): Promise<void> {
		return new Promise((resolve) => {
			const fallback = setTimeout(resolve, 420);
			sheet?.addEventListener(
				'transitionend',
				() => {
					clearTimeout(fallback);
					resolve();
				},
				{ once: true }
			);
		});
	}

	function requestClose() {
		if (!open) return;
		open = false;
		onclose?.();
	}

	// ---- swipe to dismiss ----------------------------------------------------------------
	let startY = 0;
	let startT = 0;

	function onpointerdown(event: PointerEvent) {
		if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
		dragging = true;
		startY = event.clientY;
		startT = event.timeStamp;
		(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
	}

	function onpointermove(event: PointerEvent) {
		if (!dragging) return;
		const dy = event.clientY - startY;
		// Resist upward drags; follow the finger downward.
		dragY = dy < 0 ? dy * 0.15 : dy;
	}

	function onpointerup(event: PointerEvent) {
		if (!dragging) return;
		dragging = false;
		const height = sheet?.offsetHeight ?? 400;
		const velocity = dragY / Math.max(1, event.timeStamp - startT); // px/ms
		if (dragY > height * 0.28 || (dragY > 24 && velocity > 0.55)) requestClose();
		else dragY = 0;
	}
</script>

<dialog
	bind:this={dialog}
	class="sheet-dialog"
	class:visible
	aria-labelledby={`${id}-title`}
	aria-describedby={description ? `${id}-desc` : undefined}
	data-testid={testId}
	oncancel={(e) => {
		e.preventDefault();
		requestClose();
	}}
>
	<div class="scrim" aria-hidden="true" onclick={requestClose}></div>
	<div
		bind:this={sheet}
		class="sheet"
		class:dragging
		tabindex="-1"
		style:--drag={`${Math.round(dragY)}px`}
	>
		<div
			class="grab-zone"
			role="presentation"
			{onpointerdown}
			{onpointermove}
			{onpointerup}
			onpointercancel={onpointerup}
		>
			<span class="handle" aria-hidden="true"></span>
			<header class="header">
				<div class="titles">
					<h2 id={`${id}-title`} class="title">{title}</h2>
					{#if description}<p id={`${id}-desc`} class="description">{description}</p>{/if}
				</div>
				<IconButton icon="close" label="Close" variant="filled" size="sm" onclick={requestClose} />
			</header>
		</div>
		<div class="body">
			{#if mounted}{@render children()}{/if}
		</div>
		{#if footer && mounted}
			<footer class="footer">{@render footer()}</footer>
		{/if}
	</div>
</dialog>

<style>
	.sheet-dialog {
		position: fixed;
		inset: 0;
		width: 100%;
		height: 100%;
		max-width: none;
		max-height: none;
		margin: 0;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--color-text);
		overflow: hidden;
		z-index: var(--z-sheet);
	}

	.sheet-dialog::backdrop {
		background: transparent;
	}

	.scrim {
		position: absolute;
		inset: 0;
		background: var(--color-overlay);
		backdrop-filter: blur(2px);
		opacity: 0;
		transition: opacity var(--duration-slow) var(--ease-standard);
	}

	.sheet {
		position: absolute;
		left: 50%;
		bottom: 0;
		width: min(100%, var(--content-max));
		max-height: calc(100dvh - var(--safe-top) - var(--space-6));
		display: flex;
		flex-direction: column;
		background: var(--color-surface-1);
		border: 1px solid var(--color-border);
		border-bottom: 0;
		border-radius: var(--radius-xl) var(--radius-xl) 0 0;
		box-shadow: var(--elevation-3);
		transform: translate(-50%, 100%);
		transition: transform var(--duration-slow) var(--ease-out);
		will-change: transform;
	}

	.sheet:focus {
		outline: none;
	}

	.visible .scrim {
		opacity: 1;
	}

	.visible .sheet {
		transform: translate(-50%, var(--drag, 0px));
	}

	.sheet.dragging {
		transition: none;
	}

	.grab-zone {
		flex: none;
		touch-action: none;
		cursor: grab;
		padding: var(--space-2) var(--gutter) var(--space-2);
	}

	.handle {
		display: block;
		width: 36px;
		height: 5px;
		margin: 0 auto var(--space-3);
		border-radius: var(--radius-full);
		background: var(--color-border-strong);
	}

	.header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: var(--space-3);
	}

	.titles {
		display: grid;
		gap: var(--space-1);
		padding-top: var(--space-1);
	}

	.title {
		font-size: var(--text-xl);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-tight);
	}

	.description {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.body {
		flex: 1;
		overflow-y: auto;
		overscroll-behavior: contain;
		padding: var(--space-2) var(--gutter) var(--space-6);
	}

	.footer {
		flex: none;
		padding: var(--space-3) var(--gutter) calc(var(--space-4) + var(--safe-bottom));
		border-top: 1px solid var(--color-hairline);
	}

	.body:last-child {
		padding-bottom: calc(var(--space-6) + var(--safe-bottom));
	}
</style>
