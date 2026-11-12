<!--
  @component
  The sheet every session edit opens in (Move, Swap, Adjust and Skip, each in SHEETS),
  code-split with the BottomSheet it holds: the session screen loads it on intent and names the
  edit (`kind`). It loads that edit's sheet when it opens, and owns what every edit shares:
  - Save in the footer, disabled and aria-busy while the edit is posted, so a second tap posts
    nothing. The sheet's `submit()` validates and posts, and answers the toast's words once
    saved; then the sheet closes, the toast says what changed and the screen's data reloads.
  - Focus: the trigger is focused before the sheet opens, so every way of closing it (Save,
    Close, Escape, a swipe) returns focus there, on Safari too, which does not focus a tapped
    button.
  - Loading: a skeleton until the sheet's code arrives. If it fails, the sheet stays open with
    'Couldn’t load this editor' and Retry, which loads it again in place (WebKit fetches anew);
    if that fails too while online, the screen reloads asking for the sheet (`?edit=<kind>`),
    because Chromium keeps a failed module fetch for the document's lifetime. An edit of one
    exercise (Swap, Adjust on an exercise) names it too (`&exercise=<lineage>`).
  The toast links to History, where the new version and its why are listed.
-->
<script module lang="ts">
	import type { Component } from 'svelte';
	import type { EditTarget, SessionEdits, SwapTarget } from './session-words';

	/** What the host asks of the sheet it holds. */
	export interface EditSheetExports {
		/**
		 * Validate and save the edit: the toast's words once saved ('Moved to Wednesday · version
		 * 2'), or null to stay open, with what went wrong shown in the sheet.
		 */
		submit(): Promise<string | null>;
	}

	/** An edit, as the host opens it on a session. */
	interface SheetEntry<P extends object> {
		title: string;
		/**
		 * Save's label for these edits (and the exercise, for an edit of one); null hides Save,
		 * when there is nothing to save.
		 */
		action: (edits: SessionEdits, exercise: SwapTarget | undefined) => string | null;
		/** The sheet, code-split: fetched when the host first opens it. */
		load: () => Promise<{ default: Component<P, EditSheetExports> }>;
		props: (
			session: EditTarget,
			edits: SessionEdits,
			exercise: SwapTarget | undefined,
			onskip: (() => void) | undefined
		) => P;
	}

	/** An entry checked against its sheet's props, then stored without their type. */
	const entry = <P extends object>(sheet: SheetEntry<P>) => sheet as unknown as SheetEntry<object>;

	/** Every edit the session screen offers, by kind. */
	const SHEETS = {
		move: entry({
			title: 'Move session',
			action: (edits) => (edits.moveTo.length ? 'Move' : null),
			load: () => import('./MoveSheet.svelte'),
			props: ({ lineage }, { version, moveTo }, _exercise, onskip) => ({
				lineage,
				version,
				targets: moveTo,
				onskip
			})
		}),
		swap: entry({
			title: 'Swap exercise',
			action: (_edits, exercise) => (exercise?.choices?.alternatives.length ? 'Swap' : null),
			load: () => import('./SwapSheet.svelte'),
			props: ({ lineage }, { version }, exercise) => ({
				sessionLineage: lineage,
				version,
				exercise: exercise!
			})
		}),
		adjust: entry({
			title: 'Adjust',
			action: () => 'Save',
			load: () => import('./AdjustSheet.svelte'),
			props: ({ lineage, title, adjust }, { version }, exercise) => ({
				sessionLineage: lineage,
				version,
				values: adjust!,
				exercise: exercise?.lineage,
				name: exercise?.name ?? title
			})
		}),
		skip: entry({
			title: 'Skip session',
			action: () => 'Skip',
			load: () => import('./SkipSheet.svelte'),
			props: ({ lineage, title }, { version }) => ({ lineage, title, version })
		})
	};

	export type EditKind = keyof typeof SHEETS;
</script>

<script lang="ts">
	import { tick } from 'svelte';
	import { goto, invalidateAll, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import BottomSheet from '../components/BottomSheet.svelte';
	import Button from '../components/Button.svelte';
	import EmptyState from '../components/EmptyState.svelte';
	import Skeleton from '../components/Skeleton.svelte';
	import { toast } from '../toast.svelte';

	interface Props {
		open: boolean;
		kind: EditKind;
		/** The session it edits, as the screen loaded it. */
		session: EditTarget;
		/** What opened the sheet: focus returns to it. */
		trigger: HTMLElement | undefined;
		/** The exercise an edit of one exercise (Swap, Adjust) is about. */
		exercise?: SwapTarget;
		/** Skip the session instead: Move offers it when no day is left. */
		onskip?: () => void;
	}

	let { open = $bindable(), kind, session, trigger, exercise, onskip }: Props = $props();

	/** What reopens this sheet after a reload. */
	const reopen = $derived(
		exercise ? `?edit=${kind}&exercise=${exercise.lineage}` : `?edit=${kind}`
	);

	const spec = $derived(SHEETS[kind]);

	let Sheet = $state.raw<Component<object, EditSheetExports> | null>(null);
	let sheet = $state<EditSheetExports>();
	let failed = $state(false);
	let fetching = false;
	/** A Retry after a reported failure: failing again online reloads the screen. */
	let retrying = false;

	function fetchSheet() {
		if (Sheet || fetching) return;
		fetching = true;
		failed = false;
		spec.load().then(
			(module) => {
				fetching = false;
				Sheet = module.default;
			},
			() => {
				fetching = false;
				if (retrying && navigator.onLine) return location.replace(reopen);
				failed = true;
			}
		);
	}

	function retry() {
		retrying = true;
		fetchSheet();
	}

	// The BottomSheet's own `open`, which follows the host's once the trigger has focus: the
	// sheet returns focus to whatever held it when it opened.
	let shown = $state(false);
	$effect(() => {
		if (open && !shown) {
			trigger?.focus({ preventScroll: true });
			shown = true;
			fetchSheet();
		} else if (!open) shown = false;
	});

	function close() {
		open = false;
		// Opened from ?edit=<kind> (after a reload): the screen's own URL again.
		if (page.url.searchParams.has('edit')) {
			replaceState(resolve('/(app)/train/session/[key]', { key: session.lineage }), {});
		}
	}

	let busy = $state(false);
	let footer = $state<HTMLElement>();

	async function save() {
		if (busy || !sheet) return;
		busy = true;
		let saved: string | null;
		try {
			saved = await sheet.submit();
		} finally {
			busy = false;
		}
		if (saved === null) {
			// Save was disabled while it posted, which drops keyboard focus: give it back, unless
			// the sheet moved it to what needs fixing.
			await tick();
			if (document.activeElement === document.body) footer?.querySelector('button')?.focus();
			return;
		}
		close();
		toast.show(saved, {
			tone: 'positive',
			action: {
				label: 'History',
				onclick: () => goto(resolve('/(app)/train/history/[[version]]', {}))
			}
		});
		await invalidateAll();
	}

	// A reload after a conflict can find the session skipped or done elsewhere: Adjust then has
	// nothing to step (`adjust` is null), so the sheet closes onto the session's new state.
	const offered = $derived(!!session.edits && (kind !== 'adjust' || !!session.adjust));
	$effect(() => {
		if (open && !offered) close();
	});

	const action = $derived(session.edits && spec.action(session.edits, exercise));
</script>

<BottomSheet
	bind:open={shown}
	title={spec.title}
	description={`${exercise?.name ?? session.title} · ${session.when}`}
	footer={Sheet && action ? saveBar : undefined}
	onclose={close}
	data-testid="edit-sheet"
>
	{#if Sheet && session.edits && offered}
		<Sheet bind:this={sheet} {...spec.props(session, session.edits, exercise, onskip)} />
	{:else if failed}
		<EmptyState
			compact
			icon="alert"
			tone="combat"
			title="Couldn’t load this editor"
			description="Check your connection, then try again. Nothing has changed."
			data-testid="edit-sheet-error"
		>
			{#snippet actions()}
				<Button variant="secondary" icon="refresh" onclick={retry}>Try again</Button>
			{/snippet}
		</EmptyState>
	{:else}
		<div class="loading" role="status" aria-busy="true" data-testid="edit-sheet-loading">
			<span class="visually-hidden">Loading the editor…</span>
			<Skeleton height="1rem" width="40%" />
			<Skeleton height="3.5rem" radius="var(--radius-md)" />
			<Skeleton height="3.5rem" radius="var(--radius-md)" />
			<Skeleton height="3.5rem" radius="var(--radius-md)" />
		</div>
	{/if}
</BottomSheet>

{#snippet saveBar()}
	<div bind:this={footer}>
		<Button block loading={busy} onclick={save} data-testid="edit-save">{action}</Button>
	</div>
{/snippet}

<style>
	.loading {
		display: grid;
		gap: var(--space-3);
		padding-bottom: var(--space-2);
	}
</style>
