<!--
  @component
  One training-profile section, edited from Profile. The server renders the screen with a
  skeleton where the editor goes; the editor, its form state and the discard sheet load on demand
  (no editor is in the route's initial JavaScript) and replace the skeleton in place. Save sits in
  the thumb zone above the tab bar, and leaving with unsaved changes asks first.
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
	}

	let { key, title, saved, context }: Props = $props();

	let Editor = $state<SectionEditor['Editor'] | null>(null);
	let form = $state<SectionForm<unknown> | null>(null);
	let Sheet = $state<typeof DiscardSheet | null>(null);
	let failed = $state(false);

	/** The editor, its form state and the discard sheet: all of them, or the error with Retry. */
	onMount(async () => {
		try {
			const [editor, { SectionForm }, { warmValidation }, sheet] = await Promise.all([
				EDITORS[key](),
				import('#lib/client/section-form.svelte.ts'),
				import('#lib/client/profile-form.ts'),
				import('./DiscardSheet.svelte')
			]);
			form = new SectionForm(editor.draft(saved), editor.schema);
			Sheet = sheet.default;
			Editor = editor.Editor;
			warmValidation();
		} catch {
			failed = true;
		}
	});

	async function save(event: MouseEvent) {
		if (!form) return;
		const button = event.currentTarget as HTMLElement;
		const outcome = await form.submit();
		// The button is disabled while it saves, which drops keyboard focus: give it back.
		if (document.activeElement === document.body) button.focus();
		// Only the action's own answer: a redirect (the session ended) saved nothing.
		if (outcome.data?.saved) toast.show('Saved', { tone: 'positive' });
	}

	// ---- leaving with unsaved changes ----------------------------------------------------------
	let asking = $state(false);
	let pending: BeforeNavigate | null = null;

	beforeNavigate((navigation) => {
		// Nothing to lose. A save in flight can end in a redirect (to sign in again, say), which
		// must go through.
		if (!form?.dirty || (form.busy && navigation.type === 'goto')) return;
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

<a class="back" href={resolve('/(app)/profile')} data-testid="back-to-profile">
	<Icon name="chevron-left" size={18} /> Profile
</a>
<PageHeader {title} eyebrow="Training profile" />

<div class="editor" aria-busy={!Editor && !failed} data-testid="section-editor">
	{#if Editor && form}
		<!-- A new editor for a new form (after Discard): its own state starts from the draft. -->
		{#each [form] as current (current)}
			<Editor bind:value={current.value} errors={current.errors} {context} />
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
			<Button variant="secondary" icon="refresh" onclick={() => location.reload()}>Retry</Button>
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

<div class="actions">
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

{#if Sheet}
	<Sheet bind:open={asking} section={title} ondiscard={discard} />
{/if}

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

	/* Room for the Save bar below, so nothing ends up under it at the end of the page. */
	.editor {
		min-height: 28rem;
		padding-bottom: calc(var(--space-20) + var(--space-2));
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
</style>
