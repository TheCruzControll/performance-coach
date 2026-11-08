<!--
  @component
  One onboarding step: Back, where the owner is in the setup (a segment per step that applies,
  marked done once the step is completed or skipped), a large title, the step's Profile editor
  and the actions in the thumb zone. The editor, its form state and validation load on demand,
  from the same registry as Profile (no editor is in the route's initial JavaScript), in place of
  a skeleton. Continue saves the step and moves on (save as you go); Skip, on optional steps
  only, moves on without saving. Back and Finish later save a changed step first, without
  marking it done, and leave even when it cannot save yet. Review shows every answer
  (ProfileSummary, also on demand), each with an Edit that opens its step and comes back to the
  review: from there Continue, Skip and Back return to the review (Back and Finish later still
  save a changed step first). Start coaching finishes the setup. The page can put more between
  the title and the editor: the welcome's intro, or on a return visit its card to pick up at the
  furthest step advanced.

  From 1024 px the step is a card centred in the window, the progress bar across its top and
  Back, Skip and Continue in a row under the form (Back is in both places, one shown per
  width, so the focus order follows the layout). The review declares wide, so its
  blocks sit in two columns.
-->
<script lang="ts">
	import { onMount, tick, type Component, type ComponentProps, type Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import type { SectionForm } from '#lib/client/section-form.svelte.ts';
	import { previousStep, STEP_INFO, type OnboardingStep } from '#lib/domain/profile/onboarding.ts';
	import type { TrainingProfile } from '#lib/domain/profile/types.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import Skeleton from '#lib/ui/components/Skeleton.svelte';
	import {
		EDITORS,
		loadSummary,
		type SectionContext,
		type SectionEditor
	} from '#lib/ui/profile/editors.ts';
	import type ProfileSummary from '#lib/ui/profile/ProfileSummary.svelte';
	import type { SectionKey } from '#lib/ui/profile/sections.ts';
	import { fromReviewHref, stepHref, todayHref } from '../paths';

	interface Props {
		step: OnboardingStep;
		/** The steps that apply, in order, and those already completed or skipped. */
		steps: OnboardingStep[];
		completed: OnboardingStep[];
		skipped: OnboardingStep[];
		/** The Profile section this step edits (null on review) and what its load returned. */
		key: SectionKey | null;
		saved: unknown;
		context: SectionContext | null;
		/** On review: the whole training profile. */
		profile: TrainingProfile | null;
		/** Opened from the review's Edit: Back, Continue and Skip return to the review. */
		fromReview: boolean;
		title: string;
		lede: string;
		continueLabel: string;
		/** Shown between the title and the editor (the welcome's intro or resume card). */
		children?: Snippet;
	}

	let {
		step,
		steps,
		completed,
		skipped,
		key,
		saved,
		context,
		profile,
		fromReview,
		title,
		lede,
		continueLabel,
		children
	}: Props = $props();

	const index = $derived(steps.indexOf(step));
	const previous = $derived(fromReview ? 'review' : previousStep(steps, step));
	const optional = $derived(STEP_INFO[step].optional);
	const finished = (s: OnboardingStep) => completed.includes(s) || skipped.includes(s);
	/** A section saved as a whole (goals save one at a time, from their sheet). */
	const savesSection = $derived(key !== null && key !== 'goals');

	let Editor = $state<SectionEditor['Editor'] | null>(null);
	let Summary = $state<Component<ComponentProps<typeof ProfileSummary>> | null>(null);
	let form = $state<SectionForm<unknown> | null>(null);
	let failed = $state(false);
	let alert = $state<HTMLElement>();
	let afterSave: SectionEditor['afterSave'];

	onMount(async () => {
		try {
			const [editor, summary, { SectionForm }, { warmValidation }] = await Promise.all([
				// Left out of the server build, which renders the skeleton (as on Profile): while the
				// server can reach an editor, SvelteKit links its CSS into the page.
				key === null || import.meta.env.SSR ? null : EDITORS[key](),
				key !== null || import.meta.env.SSR ? null : loadSummary(),
				import('#lib/client/section-form.svelte.ts'),
				import('#lib/client/profile-form.ts')
			]);
			form = editor
				? new SectionForm(editor.draft(saved, context!), editor.schema, editor.payload)
				: new SectionForm<unknown>({});
			Editor = editor?.Editor ?? null;
			Summary = summary?.default ?? null;
			afterSave = editor?.afterSave;
			warmValidation();
		} catch {
			failed = true;
		}
	});

	/**
	 * Messages about the step as a whole (no goal yet), else the form's own. On review, what
	 * Start coaching needs is shown on the block it belongs to instead.
	 */
	const messages = $derived.by(() => {
		if (!form) return [];
		if (key === null && Object.keys(form.errors).length) return [];
		const own = savesSection ? [] : Object.values(form.errors);
		return own.length ? own : form.failed ? [form.failed] : [];
	});

	/** Opened from the review's Edit, the action is told so: it then redirects to the review. */
	const target = (action: '?/save' | '?/skip' | '?/complete') =>
		fromReview ? `${action}&then=review` : action;

	async function go(action: '?/save' | '?/skip' | '?/complete') {
		if (!form) return;
		const sent = JSON.parse(JSON.stringify(form.value)) as unknown;
		const outcome = await form.submit(target(action), undefined, {
			validate: action === '?/save' && savesSection
		});
		// The redirect to the next step has been followed: the device's units follow a welcome.
		if (outcome.ok && action === '?/save') afterSave?.(sent);
		// A message about the step as a whole (no goal yet, no connection) takes focus, as a field
		// error does: the button pressed was disabled while it posted, which dropped focus.
		await tick();
		if (!outcome.ok && !document.querySelector('[aria-invalid="true"]')) alert?.focus();
	}

	/**
	 * Back and Finish later: a changed step saves first, as an edit (the step is not marked
	 * done). A half-filled step that cannot save yet leaves all the same, quietly: its errors
	 * neither show nor take focus on the way out. Unchanged, the link simply goes. Opened from
	 * the review, Back's save redirects to the review (its link's href), not the step before.
	 */
	async function leave(event: MouseEvent, then: 'back' | 'later', href: string) {
		const newTab = event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey;
		if (!form || !savesSection || !form.dirty || newTab) return;
		event.preventDefault();
		if (form.busy) return;
		const sent = JSON.parse(JSON.stringify(form.value)) as unknown;
		const outcome = await form.submit(target('?/save'), { then }, { quiet: true });
		if (outcome.ok) afterSave?.(sent);
		// Saved on the way back: the redirect to the step before (or the review) has been followed.
		if (outcome.ok && then === 'back') return;
		// eslint-disable-next-line svelte/no-navigation-without-resolve -- stepHref/todayHref resolve()
		await goto(href);
	}
</script>

<!-- Data preloads on tap, not hover: the step before has its Back in the same place, under the
     pointer this click leaves, and a hover preload there would fetch the data of the step before
     that for nobody (WebKit reports it as a page error when a page load cancels it). -->
{#snippet back(to: OnboardingStep, where: 'head' | 'row')}
	<a
		class="nav back {where}"
		href={stepHref(to)}
		onclick={(event) => leave(event, 'back', stepHref(to))}
		data-sveltekit-preload-data="tap"
		data-testid={where === 'head' ? 'step-back' : 'step-back-row'}
	>
		<Icon name="chevron-left" size={20} /> Back
	</a>
{/snippet}

<div class="step" data-step={step} data-layout={key === null ? 'wide' : undefined}>
	<header class="top">
		{#if previous}
			{@render back(previous, 'head')}
		{:else}
			<span></span>
		{/if}
		<span class="count numeric" aria-hidden="true">{index + 1} / {steps.length}</span>
		<a
			class="nav later"
			href={todayHref()}
			onclick={(event) => leave(event, 'later', todayHref())}
			data-testid="finish-later">Finish later</a
		>
	</header>

	<div
		class="progress"
		role="progressbar"
		aria-label="Setup progress"
		aria-valuemin={1}
		aria-valuemax={steps.length}
		aria-valuenow={index + 1}
		aria-valuetext={`Step ${index + 1} of ${steps.length}: ${STEP_INFO[step].title}`}
		data-testid="step-progress"
	>
		{#each steps as s (s)}
			<span
				class="segment"
				class:done={finished(s)}
				class:current={s === step}
				data-step={s}
				data-done={finished(s)}
			></span>
		{/each}
	</div>

	<div class="intro">
		<p class="eyebrow">
			{STEP_INFO[step].short}{#if optional}<span class="opt">· Optional</span>{/if}
		</p>
		<h1 class="title">{title}</h1>
		<p class="lede">{lede}</p>
		{#if children}<div class="lead">{@render children()}</div>{/if}
	</div>

	<div class="body" aria-busy={!form && !failed} data-testid="section-editor">
		{#if failed}
			<div class="failed">
				<Notice tone="danger" title="This step didn’t load" data-testid="editor-error">
					Check your connection, then try again.
				</Notice>
				<!-- A reload: the browser keeps a failed module fetch for the life of the page. -->
				<Button variant="secondary" icon="refresh" onclick={() => location.reload()}>Retry</Button>
			</div>
		{:else if Editor && form}
			<Editor bind:value={form.value} errors={form.errors} context={context!} />
		{:else if Summary && form && profile}
			<Summary {profile} {steps} errors={form.errors} href={fromReviewHref} />
		{:else}
			<div class="placeholder">
				<span class="visually-hidden">Loading {title}…</span>
				<Skeleton width="55%" height="0.875rem" />
				<Skeleton height="3.5rem" radius="var(--radius-md)" />
				<Skeleton height="3.5rem" radius="var(--radius-md)" />
				<Skeleton height="5.5rem" radius="var(--radius-md)" />
			</div>
		{/if}
	</div>

	<div class="actions">
		{#if messages.length}
			<div class="alert" tabindex="-1" bind:this={alert} data-testid="step-error">
				<Notice tone="danger">
					{#each messages as message (message)}<p>{message}</p>{/each}
				</Notice>
			</div>
		{/if}
		<div class="buttons">
			{#if previous}{@render back(previous, 'row')}{/if}
			{#if optional}
				<Button
					variant="ghost"
					size="lg"
					disabled={!form || form.busy}
					onclick={() => go('?/skip')}
					data-testid="step-skip">Skip</Button
				>
			{/if}
			<Button
				size="lg"
				block
				iconEnd="arrow-right"
				loading={form?.busy}
				disabled={!form}
				onclick={() => go(key === null ? '?/complete' : '?/save')}
				data-testid="step-continue">{continueLabel}</Button
			>
		</div>
	</div>
</div>

<style>
	.step {
		display: grid;
		grid-template-rows: auto auto auto 1fr auto;
		min-height: calc(100dvh - var(--safe-top));
	}

	.top {
		display: grid;
		grid-template-columns: 1fr auto 1fr;
		align-items: center;
		min-height: 3.25rem;
	}

	.nav {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		min-height: var(--touch-target);
		border-radius: var(--radius-sm);
		font-size: var(--text-sm);
		font-weight: var(--weight-medium);
		color: var(--color-text-secondary);
		transition: color var(--duration-fast) var(--ease-standard);
	}

	.back {
		justify-self: start;
		margin-left: calc(-1 * var(--space-1));
		color: var(--color-text);
	}

	.later {
		justify-self: end;
	}

	/* Back's place in the action row, a desktop window's (below). */
	.back.row {
		display: none;
	}

	@media (hover: hover) and (pointer: fine) {
		.nav:hover {
			color: var(--color-accent-text);
		}
	}

	.count {
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-caps);
		color: var(--color-text-tertiary);
	}

	.progress {
		display: flex;
		gap: 3px;
		margin: var(--space-1) 0 var(--space-6);
	}

	.segment {
		flex: 1;
		height: 4px;
		border-radius: var(--radius-full);
		background: var(--color-surface-3);
		transition: background-color var(--duration-slow) var(--ease-standard);
	}

	.segment.done {
		background: color-mix(in srgb, var(--color-accent) 55%, var(--color-surface-3));
	}

	.segment.current {
		background: var(--color-accent);
	}

	.intro {
		display: grid;
		gap: var(--space-2);
		margin-bottom: var(--space-6);
	}

	.eyebrow {
		font-size: var(--text-2xs);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
		color: var(--color-accent-text);
	}

	.opt {
		margin-left: var(--space-1);
		color: var(--color-text-secondary);
	}

	.title {
		font-family: var(--font-display);
		font-size: var(--text-3xl);
		font-weight: var(--weight-bold);
		letter-spacing: var(--tracking-display);
		line-height: var(--leading-tight);
	}

	.lede {
		color: var(--color-text-secondary);
	}

	.lead {
		margin-top: var(--space-4);
	}

	/* A container, so the review's summary lays out by the room it has (two columns when wide). */
	.body {
		container-type: inline-size;
		padding-bottom: var(--space-8);
	}

	.placeholder,
	.failed {
		display: grid;
		gap: var(--space-4);
	}

	.failed {
		justify-items: start;
		gap: var(--space-3);
	}

	/* Column chrome: sticky at the foot of the step's column, content scrolling under a fade. */
	.actions {
		position: sticky;
		bottom: 0;
		z-index: var(--z-sticky);
		display: grid;
		gap: var(--space-3);
		margin: 0 calc(-1 * var(--gutter));
		padding: var(--space-6) var(--gutter) calc(var(--space-4) + var(--safe-bottom));
		background: linear-gradient(to bottom, transparent, var(--color-canvas) var(--space-6));
	}

	.alert {
		border-radius: var(--radius-md);
	}

	.buttons {
		display: flex;
		gap: var(--space-2);
	}

	/*
	 * A desktop window: the step is a card as tall as the window allows (capped), the same size on
	 * every step, so moving on moves neither the card nor its action row. The progress bar runs
	 * across its top edge; the form scrolls inside it when it is taller than the room; the actions
	 * close the card in a row under the form, Continue at the right, never pinned to the window.
	 */
	@media (width >= 64rem) {
		.step {
			--card-padding: var(--space-8);
			grid-template-rows: auto auto auto minmax(0, 1fr) auto;
			height: min(calc(100dvh - 2 * var(--space-10)), 52rem);
			min-height: 0;
			padding: 0 var(--card-padding);
			border: 1px solid var(--color-border);
			border-radius: var(--radius-xl);
			background: var(--color-surface-1);
			box-shadow: var(--elevation-2);
			overflow: clip;
		}

		.progress {
			order: -1;
			margin: 0 calc(-1 * var(--card-padding));
		}

		.segment {
			border-radius: 0;
		}

		.top {
			padding-top: var(--space-3);
		}

		/* Back moves to the action row; hidden, the header's keeps its grid cell and leaves the
		   focus order. */
		.back.head {
			visibility: hidden;
		}

		.back.row {
			display: inline-flex;
			margin-right: auto;
			padding: 0 var(--space-2);
		}

		/* The title and its lede stay a readable measure on the wide review. */
		.intro {
			max-width: var(--content-readable);
			margin-bottom: var(--space-4);
		}

		/* Room inside the scroll edge for the fields' focus rings. */
		.body {
			margin: 0 calc(-1 * var(--space-2));
			padding: var(--space-2) var(--space-2) var(--space-6);
			overflow-y: auto;
		}

		.actions {
			position: static;
			margin: 0 calc(-1 * var(--card-padding));
			padding: var(--space-4) var(--card-padding) var(--space-6);
			border-top: 1px solid var(--color-border);
			background: none;
		}

		.buttons {
			justify-content: flex-end;
		}

		.buttons :global(.block) {
			width: auto;
			min-width: 12rem;
		}
	}
</style>
