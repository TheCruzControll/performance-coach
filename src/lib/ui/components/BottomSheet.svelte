<!--
  @component
  Modal bottom sheet built on the native <dialog> (showModal): focus is trapped and the page
  behind is inert by the platform itself; Escape and backdrop tap close; focus returns to the
  opener. Drag the handle/header down with a finger or a pen to dismiss (distance or velocity
  threshold). From 1024 px it opens as a dialog centred in the window, with no handle; `wide` makes
  that dialog wide enough for a table.
-->
<script lang="ts">
	import { onDestroy, type Snippet } from 'svelte';
	import { returnFocus } from '../focus-return.ts';
	import { lockScroll } from '../scroll-lock.ts';
	import IconButton from './IconButton.svelte';

	interface Props {
		open: boolean;
		title: string;
		description?: string;
		/** From 1024 px, a wider dialog: room for a table. */
		wide?: boolean;
		onclose?: () => void;
		footer?: Snippet;
		'data-testid'?: string;
		children: Snippet;
	}

	let {
		open = $bindable(),
		title,
		description,
		wide = false,
		onclose,
		footer,
		'data-testid': testId,
		children
	}: Props = $props();

	const id = $props.id();
	let dialog: HTMLDialogElement | undefined = $state();
	let sheet: HTMLDivElement | undefined = $state();
	let body: HTMLDivElement | undefined = $state();
	/** The content is taller than the sheet: the body is a tab stop, so a keyboard scrolls it. */
	let scrolls = $state(false);
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

	// Measured as the window or the content resizes, and as the content's elements change.
	$effect(() => {
		const el = body;
		if (!el || !mounted) return;
		const measure = () => (scrolls = el.scrollHeight > el.clientHeight);
		const resized = new ResizeObserver(measure);
		const watch = () => {
			resized.disconnect();
			resized.observe(el);
			for (const child of el.children) resized.observe(child);
		};
		const changed = new MutationObserver(() => {
			watch();
			measure();
		});
		changed.observe(el, { childList: true });
		watch();
		return () => {
			resized.disconnect();
			changed.disconnect();
			scrolls = false;
		};
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
		// Focus goes back where it was; when it was nowhere (the button that asked was disabled
		// while it worked), into the sheet this one opens over.
		const focused = document.activeElement;
		opener =
			focused instanceof HTMLElement && focused !== document.body
				? focused
				: document.querySelector<HTMLElement>('.sheet-dialog[open] > .sheet');
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
		// Again on the next frames while WebKit refuses it (focus-return.ts), unless this sheet has
		// opened again or focus is somewhere outside it.
		if (opener?.isConnected) {
			returnFocus(opener, () => {
				const at = document.activeElement;
				return !dialog?.open && (!at || at === document.body || !!dialog?.contains(at));
			});
		}
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
		// Only a finger or a pen drags the sheet: a mouse has Escape, the backdrop and Close.
		if (!['touch', 'pen'].includes(event.pointerType) || event.button !== 0) return;
		if ((event.target as HTMLElement).closest('button')) return;
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
	class:wide
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
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div
			bind:this={body}
			class="body"
			role={scrolls ? 'region' : undefined}
			aria-labelledby={scrolls ? `${id}-title` : undefined}
			tabindex={scrolls ? 0 : undefined}
		>
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

	/* No backdrop blur: under the fade, a blur of the whole screen behind it is redrawn every frame
	   (10-16 ms a frame in CI's software compositor, against 3-5 without the sheet), and the
	   sheet's motion dropped frames (perf-workout.e2e.ts). */
	.scrim {
		position: absolute;
		inset: 0;
		background: var(--color-overlay);
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

	/* Inside the body: the sheet's edges would clip a ring drawn outside it. */
	.body:focus-visible {
		outline-offset: -2px;
	}

	.footer {
		flex: none;
		padding: var(--space-3) var(--gutter) calc(var(--space-4) + var(--safe-bottom));
		border-top: 1px solid var(--color-hairline);
	}

	.body:last-child {
		padding-bottom: calc(var(--space-6) + var(--safe-bottom));
	}

	/* A desktop window: a dialog centred in the window that fades in as it rises 8 px, with no
	   handle; its content scrolls inside. A finger still swipes it down: a wide screen can be a
	   touch screen. */
	@media (width >= 64rem) {
		.sheet {
			inset: 0;
			width: min(100% - 2 * var(--gutter), 32rem);
			height: fit-content;
			max-height: min(85dvh, 48rem);
			margin: auto;
			border-bottom: 1px solid var(--color-border);
			border-radius: var(--radius-xl);
			opacity: 0;
			transform: translateY(8px);
			transition:
				opacity var(--duration-base) var(--ease-standard),
				transform var(--duration-base) var(--ease-out);
		}

		.visible .sheet {
			opacity: 1;
			transform: translateY(var(--drag, 0px));
		}

		.wide .sheet {
			width: min(100% - 2 * var(--gutter), 56rem);
		}

		.handle {
			display: none;
		}

		.grab-zone {
			padding-top: var(--space-5);
		}
	}
</style>
