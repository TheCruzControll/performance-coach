<!--
  @component
  One training-profile section, edited from Profile. The server renders the screen with a
  skeleton where the editor goes; the editor, its form state and the discard sheet load on demand
  (no editor is in the route's initial JavaScript) and replace the skeleton in place. Save sits in
  the thumb zone above the tab bar, and leaving with unsaved changes asks first. A section whose
  every change saves itself (Goals) has neither. From 1024 px this is the editor column beside
  the section list: no back link, and Save is column chrome, sticky at the column's foot.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { beforeNavigate, goto, type BeforeNavigate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { SectionForm } from '#lib/client/section-form.svelte.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';
	import Skeleton from '#lib/ui/components/Skeleton.svelte';
	import { EDITORS, type SectionContext, type SectionEditor } from '#lib/ui/profile/editors.ts';
	import type { SectionKey } from '#lib/ui/profile/sections.ts';
	import { toast } from '#lib/ui/toast.svelte.ts';
	import type DiscardSheet from './DiscardSheet.svelte';

	interface Props {
		key: SectionKey;
		title: string;
		/** What the section's load returned: the editor's state is built from it. */
		saved: unknown;
		context: SectionContext;
		/** The section saves as a whole, from the Save bar (false: each change saves itself). */
		saveBar: boolean;
	}

	let { key, title, saved, context, saveBar }: Props = $props();

	let Editor = $state<SectionEditor['Editor'] | null>(null);
	let form = $state<SectionForm<unknown> | null>(null);
	let Sheet = $state<typeof DiscardSheet | null>(null);
	let failed = $state(false);
	/** A form for the section as stored: what the load returned, then what each save stored. */
	let formFor: ((stored: unknown) => SectionForm<unknown>) | undefined;
	let afterSave: SectionEditor['afterSave'];

	/** The editor, its form state and the discard sheet: all of them, or the error with Retry. */
	onMount(async () => {
		try {
			const [editor, { SectionForm }, { warmValidation }, sheet] = await Promise.all([
				// Left out of the server build, which only renders the skeleton: while the server
				// can reach an editor, SvelteKit links its CSS into every section's page.
				import.meta.env.SSR ? Promise.reject(new Error('client only')) : EDITORS[key](),
				import('#lib/client/section-form.svelte.ts'),
				import('#lib/client/profile-form.ts'),
				import('./DiscardSheet.svelte')
			]);
			formFor = (stored) =>
				new SectionForm(editor.draft(stored, context), editor.schema, editor.payload);
			form = formFor(saved);
			Sheet = sheet.default;
			Editor = editor.Editor;
			afterSave = editor.afterSave;
			warmValidation();
		} catch {
			failed = true;
		}
	});

	async function save(event: MouseEvent) {
		if (!form) return;
		const button = event.currentTarget as HTMLElement;
		// What this save sends: an edit made while it is in flight is not part of it.
		const sent = JSON.stringify(form.value);
		const outcome = await form.submit();
		// The button is disabled while it saves, which drops keyboard focus: give it back.
		if (document.activeElement === document.body) button.focus();
		// Only the action's own answer: a redirect (the session ended) saved nothing.
		if (!outcome.data?.saved) return;
		afterSave?.(JSON.parse(sent));
		// Go on from what was stored: a new injury has its id now, so saving again updates it
		// instead of adding it once more. Edits made while it saved stay, unsaved.
		if (!form.dirty && formFor) form = formFor(outcome.data.section);
		toast.show('Saved', { tone: 'positive' });
	}

	// ---- leaving with unsaved changes ----------------------------------------------------------
	let asking = $state(false);
	let pending: BeforeNavigate | null = null;

	beforeNavigate((navigation) => {
		// Nothing to lose (every change already saved itself, or none was made). A save in flight
		// can end in a redirect (to sign in again, say), which must go through.
		if (!saveBar || !form?.dirty || (form.busy && navigation.type === 'goto')) return;
		navigation.cancel();
		// Reloading, closing the tab or leaving the app: the browser asks instead.
		if (navigation.type === 'leave') return;
		pending = navigation;
		asking = true;
	});

	/** Carry on to where the owner was going, without the changes. */
	function discard() {
		const to = pending?.to;
		if (!pending || !to || !form) return;
		// The edits go now, not when the next screen shows: Back before it has rendered (a
		// navigation can wait on the view transition) comes back to this screen as saved.
		form = form.reverted();
		asking = false;
		if (pending.type === 'popstate') history.go(pending.delta);
		else if (pending.willUnload) location.assign(to.url);
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- where SvelteKit was going
		else void goto(to.url);
	}
</script>

<div class="column" data-testid="section-column">
	<a class="back" href={resolve('/(app)/profile')} data-testid="back-to-profile">
		<Icon name="chevron-left" size={18} /> Profile
	</a>
	<PageHeader {title} eyebrow="Training profile" />

	<div
		class="editor"
		class:bar={saveBar}
		class:with-message={form?.failed}
		aria-busy={!Editor && !failed}
		data-testid="section-editor"
	>
		{#if Editor && form}
			<!-- A new editor for a new form (after Discard or Save): its own state starts from the draft. -->
			{#each [form] as current (current)}
				<Editor bind:value={current.value} errors={current.errors} {context} manage />
			{/each}
		{:else if failed}
			<div class="failed">
				<Notice tone="danger" title="This section didn’t load" data-testid="editor-error">
					Check your connection, then try again.
				</Notice>
				<!-- A reload: the browser keeps a failed module fetch for the life of the page, so
			     importing it again fails at once (and a deploy may have replaced the chunk). The
			     editor's code is never a modulepreload, whose failure WebKit would carry over the
			     reload (vite.config.ts, build.modulePreload). -->
				<Button variant="secondary" icon="refresh" onclick={() => location.reload()}
					>Try again</Button
				>
			</div>
		{:else}
			<!-- Shaped like a form: labels over fields, a row of choices, a notes box. -->
			<div class="placeholder">
				<span class="visually-hidden">Loading {title}…</span>
				<div class="group">
					<Skeleton width="55%" height="0.875rem" />
					<Skeleton height="3.5rem" radius="var(--radius-md)" />
					<Skeleton height="3.5rem" radius="var(--radius-md)" />
					<Skeleton height="3.5rem" radius="var(--radius-md)" />
				</div>
				<div class="group">
					<Skeleton width="35%" height="0.875rem" />
					<div class="pills">
						{#each ['6.5rem', '5rem', '7.5rem', '4.5rem', '6rem', '8rem', '5.5rem'] as width, i (i)}
							<Skeleton {width} height="2.75rem" radius="var(--radius-full)" />
						{/each}
					</div>
				</div>
				<div class="group">
					<Skeleton width="40%" height="0.875rem" />
					<Skeleton height="5.5rem" radius="var(--radius-md)" />
				</div>
			</div>
		{/if}
	</div>

	{#if saveBar}
		<div class="actions" data-testid="save-bar">
			{#if form?.failed}
				<Notice tone="danger" data-testid="save-error">{form.failed}</Notice>
			{/if}
			<Button
				size="lg"
				block
				loading={form?.busy}
				disabled={!form}
				onclick={save}
				data-testid="save-section"
			>
				Save
			</Button>
		</div>
	{/if}

	{#if Sheet}
		<Sheet bind:open={asking} section={title} ondiscard={discard} />
	{/if}
</div>

<style>
	.back {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		min-height: var(--touch-target);
		margin-top: var(--space-2);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
	}

	/* The room the skeleton reserves, so the editor that replaces it moves nothing below. */
	.editor {
		min-height: 28rem;
	}

	/* Room for the Save bar below, so nothing ends up under it at the end of the page. */
	.editor.bar {
		padding-bottom: calc(var(--space-20) + var(--space-2));
	}

	/* A message over Save (up to two lines) makes the bar taller: the room grows with it. */
	.editor.with-message {
		padding-bottom: calc(var(--space-20) * 2 + var(--space-2));
	}

	.placeholder,
	.failed {
		display: grid;
		gap: var(--space-6);
	}

	.failed {
		justify-items: start;
		gap: var(--space-3);
	}

	.group {
		display: grid;
		gap: var(--space-2);
	}

	.pills {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	/* The thumb zone: fixed above the tab bar, over a fade so scrolling content reads as behind.
	   Screen chrome: centred over the content column, clear of the bottom bar or the rail. */
	.actions {
		position: fixed;
		z-index: var(--z-sticky);
		left: calc(50% + var(--nav-inset-left) / 2);
		bottom: var(--nav-inset-bottom);
		transform: translateX(-50%);
		display: grid;
		gap: var(--space-3);
		width: min(calc(100% - var(--nav-inset-left) - 2 * var(--gutter)), var(--content-column));
		padding: var(--space-3) 0;
	}

	.actions::before {
		content: '';
		position: absolute;
		z-index: -1;
		inset: calc(var(--space-6) * -1) calc(var(--gutter) * -1) 0;
		background: linear-gradient(to bottom, transparent, var(--color-canvas) var(--space-6));
		pointer-events: none;
	}

	/*
	 * Desktop: the editor column of a split screen. The list beside it says where you are.
	 * - The skeleton reserves the window's height below the title, so Save starts at the window's
	 *   foot and stays there when the editor arrives, however long the section is.
	 * - Save is column chrome: sticky at the foot of this column, its width, never over the list,
	 *   and under the last field once scrolled to the end, so the editor needs no room kept for it.
	 *   Its fade reaches a gutter either side, inside the grid's gap.
	 */
	@media (width >= 64rem) {
		.column {
			/* What the window shows besides the editor: the title above it (about 6.6rem) and
			   the Save bar below (5rem), a little less, so the column always reaches past the
			   window's foot and Save is pinned there from the first paint. */
			--editor-reserve-offset: 11rem;
		}

		.back {
			display: none;
		}

		.editor {
			min-height: max(28rem, calc(100dvh - var(--editor-reserve-offset)));
		}

		.editor.bar,
		.editor.with-message {
			padding-bottom: 0;
		}

		.actions {
			position: sticky;
			left: auto;
			transform: none;
			width: auto;
		}
	}
</style>
