<!--
  @component
  No workout on this device (Instrument v2, Paper 4 · Train "Logging off the plan"):
  "What did you do", for anything not on the plan, as three rows: Strength, A run, or Muay Thai or
  something else, which asks "What kind" as a step of this page (shallow-routed with pushState,
  so the phone's Back returns to the first step). Each answer starts that session
  (/workout?new=strength|run, or ?new=other&kind=<type>, StartFlow.svelte); a strength one starts
  empty, and each exercise is added from the library. Those links reload the page
  (data-sveltekit-reload), because the page reads the query once mounted; offline, the service
  worker serves it from the precache.
  - The Shell draws no header here: the × at the top goes back where the owner came from in the
    app (`inApp`), or to Today when the page was opened directly (a reload, a bookmark). The
    Shell's sync pill (`status`) sits beside it once a change has been waiting, as after a
    discard, so the sync sheet and its Try again stay one tap away.
  - Moving between the steps moves the focus: to "What kind" on the way in, back to its row on
    the way back. A reload drops the step (page.state is empty then), and the history entry's
    stale state with it, so it can't come back.
  - The statement sits at the foot of the window over its rows, a thumb's reach away; from
    1024 px the same, in the readable column.
  - Nothing reads the URL while prerendering: page.state is empty then.
-->
<script lang="ts">
	import { onMount, tick, type Snippet } from 'svelte';
	import { pushState, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import Icon from '#lib/ui/components/Icon.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';
	import { KIND_CHOICES } from './session/session-words.ts';

	interface Props {
		/** Arrived from another page of the app: the × goes back there. */
		inApp?: boolean;
		/** The Shell's sync pill, once a change has waited: in the top line, beside the ×. */
		status?: Snippet;
	}

	let { inApp = false, status }: Props = $props();

	const workout = resolve('/workout');
	const kinds = $derived(page.state.logKind === true);

	let section: HTMLElement | undefined = $state();
	let kindTitle: HTMLElement | undefined = $state();

	// A step change moves the focus with it, never on the first render: into "What kind", its
	// heading; back, the row that asked it.
	let rendered = false;
	$effect(() => {
		const step = kinds;
		if (!rendered) {
			rendered = true;
			return;
		}
		void tick().then(() => {
			if (step) kindTitle?.focus();
			else section?.querySelector<HTMLElement>('[data-testid="adhoc-other"]')?.focus();
		});
	});

	// After a reload page.state is empty, but the history entry still carries the step: drop it,
	// so it can't return. The router has started by now: this page shows once the restore is done.
	onMount(() => {
		if (!page.state.logKind && JSON.stringify(history.state ?? null).includes('logKind'))
			void replaceState('', {});
	});

	function close(event: MouseEvent) {
		if (!inApp) return;
		event.preventDefault();
		history.back();
	}
</script>

<section
	class="empty"
	aria-labelledby="empty-title"
	bind:this={section}
	data-testid="workout-empty"
>
	<div class="top" data-step={kinds ? 'kinds' : 'what'}>
		{#if kinds}
			<button type="button" class="back-link" onclick={() => history.back()} data-testid="log-back">
				<Icon name="chevron-left" size={16} />Back
			</button>
			{@render status?.()}
		{:else}
			{@render status?.()}
			<a
				class="close"
				href={resolve('/(app)/today')}
				onclick={close}
				aria-label="Close"
				data-testid="workout-close"
			>
				<Icon name="close" size={16} />
			</a>
		{/if}
	</div>

	{#if kinds}
		<h1 id="empty-title" class="title" tabindex="-1" bind:this={kindTitle}>What kind</h1>
		<div class="rows kinds" data-sveltekit-reload>
			{#each KIND_CHOICES as kind (kind.value)}
				<ListRow
					title={kind.label}
					href="{workout}?new=other&kind={kind.value}"
					trailing={none}
					data-testid="adhoc-kind-{kind.value}"
				/>
			{/each}
		</div>
	{:else}
		<div class="room"></div>
		<h1 id="empty-title" class="statement">What did you do</h1>
		<p class="lead">Anything that is not on the plan. It still counts.</p>
		<!-- The Muay Thai row is a button: the reload is for the links. -->
		<div class="rows" data-sveltekit-reload>
			<ListRow
				title="Strength"
				value="Log sets as you go"
				href="{workout}?new=strength"
				data-testid="adhoc-strength"
			/>
			<ListRow
				title="A run"
				value="Distance and time"
				href="{workout}?new=run"
				data-testid="adhoc-run"
			/>
			<ListRow
				title="Muay Thai or something else"
				onclick={() => pushState('', { logKind: true })}
				data-testid="adhoc-other"
			/>
		</div>
	{/if}
</section>

{#snippet none()}{/snippet}

<style>
	/* The whole window below the safe area: the statement and its rows sit at its foot. */
	.empty {
		display: flex;
		flex: 1;
		flex-direction: column;
		padding-top: var(--safe-top);
	}

	/* Paper: a 44 px line 12 px down, the × at its right (Back at its left on the second step). The
	   sync pill, once a change has waited, sits at the right too, before the ×. */
	.top {
		display: flex;
		justify-content: flex-end;
		align-items: center;
		gap: var(--space-2);
		min-height: var(--touch-target);
		margin-top: var(--space-1);
	}

	.top[data-step='kinds'] {
		justify-content: flex-start;
	}

	/* Its own line here: the shared rule's top margin is the line's. */
	.top .back-link {
		margin-top: 0;
	}

	/* The glyph at the column's edge, its 44 px target reaching past it. */
	.close {
		display: grid;
		place-items: center;
		width: var(--touch-target);
		height: var(--touch-target);
		margin-right: calc((var(--touch-target) - 1rem) / -2);
		border-radius: var(--radius-full);
		color: var(--color-text-secondary);
	}

	@media (hover: hover) and (pointer: fine) {
		.close:hover {
			color: var(--color-text);
		}
	}

	.room {
		flex: 1;
	}

	.statement {
		font: var(--type-statement);
		letter-spacing: var(--tracking-statement);
	}

	.lead {
		margin-top: var(--space-2);
		font: var(--type-body);
		color: var(--color-text-secondary);
	}

	.title {
		margin-top: var(--space-10);
		font: var(--type-title);
		letter-spacing: var(--tracking-display);
	}

	/* Paper: 24 px above the rows and 56 px under them, the Shell's 32 px foot included. */
	.rows {
		display: grid;
		margin-top: var(--space-6);
		padding-bottom: var(--space-6);
	}

	@media (width >= 64rem) {
		.empty {
			width: min(100%, var(--content-readable));
			margin-inline: auto;
		}
	}
</style>
