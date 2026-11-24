<!--
  @component
  One training-profile section, edited from Profile (Paper, 9 · "Section"): its title (40/44), an
  optional lede, then the editor's fields and rows. The editor, its form state and the discard
  sheet load on demand (no editor is in the route's initial JavaScript): the screen is its title
  while the editor loads, then the editor; one that fails to load says so, with Try again. An
  editor may open sub-screens (subscreens.svelte.ts), which take the header's place. Save sits in
  the thumb zone above the tab bar once the editor is there, and leaving with unsaved changes asks
  first. A section whose every change saves itself (Goals) has neither. From 1024 px this is the
  column beside the section list, with no back link: the title is 32/38, and Save sits 40 px under
  a 440 px form, not pinned.
-->
<script lang="ts">
	import { onMount } from 'svelte';
	import { beforeNavigate, goto, invalidate, type BeforeNavigate } from '$app/navigation';
	import { resolve } from '$app/paths';
	import type { SectionForm } from '#lib/client/section-form.svelte.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import { EDITORS, type SectionContext, type SectionEditor } from '#lib/ui/profile/editors.ts';
	import { SECTIONS, type SectionInfo, type SectionKey } from '#lib/ui/profile/sections.ts';
	import { provideSubScreens } from '#lib/ui/profile/subscreens.svelte.ts';
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

	/** The sub-screens the editor opens: the innermost one's header takes this screen's. */
	const subs = provideSubScreens();
	const lede = $derived((SECTIONS as readonly SectionInfo[]).find((s) => s.key === key)?.lede);

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
				// Left out of the server build, which only renders the title: while the server
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
		void invalidate('app:profile-answers');
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
		// Leaving the section: none of its sub-screens is open when it comes back.
		subs.reset();
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
	{#if subs.top}
		<!-- A sub-screen: back to the screen under it, inside the section (Back leaves it). -->
		<button type="button" class="back-link sub" onclick={() => subs.close()} data-testid="sub-back">
			<Icon name="chevron-left" size={16} />
			{subs.top.back}
		</button>
		<h1 class="title" class:statement={subs.top.statement} tabindex="-1" data-subscreen-title>
			{subs.top.title}
		</h1>
		{#if subs.top.lede}<p class="lede">{subs.top.lede}</p>{/if}
	{:else}
		<a class="back-link" href={resolve('/(app)/profile')} data-testid="back-to-profile">
			<Icon name="chevron-left" size={16} /> Profile
		</a>
		{#if failed}
			<!-- The failure is the screen's statement; the title stays for the document's outline. -->
			<h1 class="visually-hidden">{title}</h1>
		{:else}
			<h1 class="title">{title}</h1>
			{#if lede}<p class="lede">{lede}</p>{/if}
		{/if}
	{/if}

	<div
		class="editor"
		class:bar={saveBar}
		class:with-message={form?.failed}
		aria-busy={!Editor && !failed}
		data-testid="section-editor"
	>
		{#if Editor && form}
			<!-- A new editor for a new form (after Discard or Save): its own state starts from the
			     draft. An open sub-screen stays open: the new editor finds it by its id. -->
			{#each [form] as current (current)}
				<Editor bind:value={current.value} errors={current.errors} {context} manage />
			{/each}
		{:else if failed}
			<div class="failed" data-testid="editor-error">
				<h2 class="statement">{title} didn’t load</h2>
				<p class="lede">Check your connection, then try again. Nothing you saved before is lost.</p>
				<!-- A reload: the browser keeps a failed module fetch for the life of the page, so
			     importing it again fails at once (and a deploy may have replaced the chunk). The
			     editor's code is never a modulepreload, whose failure WebKit would carry over the
			     reload (vite.config.ts, build.modulePreload). -->
				<Button variant="secondary" size="lg" block onclick={() => location.reload()}>
					Try again
				</Button>
			</div>
		{:else}
			<!-- While the editor loads the screen is its title (Paper: no skeletons); the room it
			     keeps means nothing below moves when the editor arrives. -->
			<span class="visually-hidden">Loading {title}…</span>
		{/if}
	</div>

	{#if saveBar && form}
		<div class="actions" data-testid="save-bar">
			{#if form.failed}
				<Notice tone="danger" data-testid="save-error">{form.failed}</Notice>
			{/if}
			<Button size="lg" block loading={form.busy} onclick={save} data-testid="save-section">
				Save
			</Button>
		</div>
	{/if}

	{#if Sheet}
		<Sheet bind:open={asking} section={title} ondiscard={discard} />
	{/if}
</div>

<style>
	/* Paper, 14 · "Profile, schedule": 440 px of form at a desk. Declared here, not in tokens.css:
	   the root layout's inlined CSS has no room to spare. */
	.column {
		--section-form: 27.5rem;
	}

	/* Hubot 40/44, 40 px under the back link (Paper, 9 · "Section"). */
	.title {
		padding-top: var(--space-10);
		font: var(--type-title);
		letter-spacing: var(--tracking-display);
	}

	/* A question as a sub-screen's title ("What do you like doing?"): 32/38. */
	.title.statement {
		font: var(--type-statement);
		letter-spacing: var(--tracking-statement);
	}

	.lede {
		margin-top: var(--space-2);
		font: var(--type-body);
		color: var(--color-text-secondary);
	}

	/* Fields 32 px under the title, 28 under a lede. The room is kept while the editor loads, so
	   the editor that arrives moves nothing below it. */
	.editor {
		min-height: 28rem;
		padding-top: var(--space-8);
	}

	.lede + .editor {
		padding-top: var(--space-7);
	}

	/* Room for the Save bar below, so nothing ends up under it at the end of the page. */
	.editor.bar {
		padding-bottom: calc(var(--space-20) + var(--space-2));
	}

	/* A message over Save (up to two lines) makes the bar taller: the room grows with it. */
	.editor.with-message {
		padding-bottom: calc(var(--space-20) * 2 + var(--space-2));
	}

	/* "Equipment didn't load": at the top, where the tab bar never covers it (Paper draws it at the
	   foot). */
	.failed {
		display: grid;
		gap: var(--space-4);
		padding-top: var(--space-10);
	}

	.failed .statement {
		font: var(--type-statement);
		letter-spacing: var(--tracking-statement);
	}

	.failed .lede {
		margin-top: 0;
	}

	/* The sub-screen's back link is a button: the shared look (layout.css) without a button's. */
	.back-link.sub {
		border: 0;
		background: none;
		padding-inline: 0;
		cursor: pointer;
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
	 * Desktop: the column of a split screen; the list beside it says where you are, so only a
	 * sub-screen's back link shows. The title is 32/38, the form 440 px wide, and Save 260 px wide
	 * 40 px under it, in the flow (Paper, 14 · "Profile, schedule"): the sections are short.
	 */
	@media (width >= 64rem) {
		.back-link:not(.sub) {
			display: none;
		}

		.title {
			font: var(--type-statement);
			letter-spacing: var(--tracking-statement);
		}

		/* No kept room: Save is in the flow, 40 px under the form, so it stays under a short one. */
		.editor {
			min-height: 0;
			max-width: var(--section-form);
		}

		.editor.bar,
		.editor.with-message {
			padding-bottom: 0;
		}

		.actions {
			position: static;
			transform: none;
			width: 16.25rem;
			margin-top: var(--space-10);
			padding: 0;
		}

		.actions::before {
			content: none;
		}
	}
</style>
