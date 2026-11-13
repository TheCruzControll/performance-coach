<!--
  @component
  A proposal in the conversation (M5 plan, coach-proposal-cards): its title, what changes (its
  rows), why, and the impact on each week it touches, or that the week's totals stay as they
  were. Nothing changes until Accept; then it says where it went: 'Applied as version N' with a
  link to that version in Train, 'Waits for your cycle review' for an accepted next cycle, or why
  it was superseded. A proposal the rules made for one of M6's reviews names it under the title
  ('From your weekly review · Week of 2 Nov', a link to the review); M6's superseded reasons, and
  'Waits for your cycle review', link to the review that took it over, and the review's own next
  cycle leads to the review to choose its start instead of offering Accept. Loaded on demand with the first card a conversation shows. Accept, Reject
  and 'Ask for changes' are the screen's (`onaccept`, `onreject`, `onrevise`); while a decision is
  on its way its button is busy and nothing else can be pressed. A decision that did not go
  through (`failed`) says so in place with Retry (`onretry`), which sends the same decision again:
  the server never applies it twice. Offline, nothing can be decided, and the card says why. The
  outcome is announced.
-->
<script lang="ts">
	import { cardState, OPEN_REVIEW, type ProposalCardView } from '#lib/domain/coach/cards.ts';
	import Badge from '../components/Badge.svelte';
	import Button from '../components/Button.svelte';
	import Icon from '../components/Icon.svelte';
	import Notice from '../components/Notice.svelte';
	import DiffRows from './DiffRows.svelte';

	interface Props {
		card: ProposalCardView;
		/** Accept, by id only; absent while the card cannot be decided here. */
		onaccept?: () => void;
		/** Opens the rejection's sheet (a reason is optional). */
		onreject?: () => void;
		/** Opens 'Ask for changes': the coach drafts a revision that replaces this proposal. */
		onrevise?: () => void;
		/** An Accept is on its way. */
		accepting?: boolean;
		/** A rejection is on its way. */
		rejecting?: boolean;
		/** The last decision did not go through, and sending it again may: Retry offers that. */
		failed?: boolean;
		onretry?: () => void;
		/** No connection: nothing can be decided until it is back. */
		offline?: boolean;
		'data-testid'?: string;
	}

	let {
		card,
		onaccept,
		onreject,
		onrevise,
		accepting = false,
		rejecting = false,
		failed = false,
		onretry,
		offline = false,
		'data-testid': testId = 'proposal-card'
	}: Props = $props();

	const busy = $derived(accepting || rejecting);
	/** A decision can be sent from here now. */
	const open = $derived(!busy && !offline);

	const id = $props.id();
	const state = $derived(cardState(card));
	/** Where accepting it left the program: the version in Train. */
	const versionHref = $derived(
		state.kind === 'applied' && state.version !== null ? `/train/history/${state.version}` : null
	);
</script>

<article
	class="proposal"
	aria-labelledby="{id}-title"
	data-status={card.status}
	data-testid={testId}
>
	<header class="head">
		<span class="eyebrow"><Icon name="sparkle" size={14} /> Proposed change</span>
		<h3 id="{id}-title" class="title">{card.title}</h3>
		{#if card.origin}
			<a class="view origin" href={card.origin.href} data-testid="proposal-origin"
				>{card.origin.words}<Icon name="chevron-right" size={14} /></a
			>
		{/if}
	</header>

	<section class="part" aria-labelledby="{id}-what">
		<h4 id="{id}-what" class="label">What changes</h4>
		{#if card.rows.length}
			<DiffRows rows={card.rows} />
		{:else}
			<p class="quiet">Nothing in your plan moves.</p>
		{/if}
	</section>

	<section class="part" aria-labelledby="{id}-why">
		<h4 id="{id}-why" class="label">Why</h4>
		<p class="why" data-testid="proposal-why">{card.rationale}</p>
	</section>

	<section class="part" aria-labelledby="{id}-impact">
		<h4 id="{id}-impact" class="label">Impact</h4>
		{#if card.impactLines.length}
			<ul class="impact" data-testid="proposal-impact">
				{#each card.impactLines as line, i (i)}<li>{line}</li>{/each}
			</ul>
		{:else}
			<p class="quiet" data-testid="proposal-impact">
				Your weekly sets, minutes and load stay as they are.
			</p>
		{/if}
		{#each card.warnings as warning, i (i)}
			<p class="warning">
				<span class="mark" aria-hidden="true"><Icon name="alert" size={14} /></span>{warning}
			</p>
		{/each}
	</section>

	<footer class="foot" data-testid="proposal-state">
		<!-- A decision that did not go through, or the offline hint; else `idle`. -->
		{#snippet hint(idle: string)}
			{#if failed && !busy}
				<div class="failure">
					<Notice tone="danger" title="Couldn’t save" data-testid="proposal-failure">
						<span id="{id}-hint"
							>Check your connection and try again. It’s never applied twice.</span
						>
						<span class="retry">
							<Button
								variant="secondary"
								size="sm"
								icon="refresh"
								disabled={offline}
								onclick={() => !offline && onretry?.()}
								data-testid="proposal-retry">Try again</Button
							>
						</span>
					</Notice>
				</div>
			{:else if offline}
				<p id="{id}-hint" class="quiet offline" data-testid="proposal-offline">
					<Icon name="wifi-off" size={14} /> You’re offline. Decide once you’re back online.
				</p>
			{:else}
				<p id="{id}-hint" class="quiet">{idle}</p>
			{/if}
		{/snippet}
		{#if state.kind === 'choose'}
			<div class="actions choose">
				<Button href={state.href} iconEnd="chevron-right" data-testid="proposal-choose-start"
					>{state.words}</Button
				>
				<Button
					variant="secondary"
					loading={rejecting}
					disabled={!onreject || (!rejecting && !open)}
					onclick={() => open && onreject?.()}
					data-testid="proposal-reject">Reject</Button
				>
			</div>
			{@render hint('Its start and a fresh preview are chosen in the review.')}
		{:else if state.kind === 'proposed'}
			<div class="actions">
				<Button
					icon="check"
					loading={accepting}
					disabled={!onaccept || (!accepting && !open)}
					onclick={() => open && onaccept?.()}
					aria-describedby="{id}-hint"
					data-testid="proposal-accept">Accept</Button
				>
				<Button
					variant="secondary"
					loading={rejecting}
					disabled={!onreject || (!rejecting && !open)}
					onclick={() => open && onreject?.()}
					data-testid="proposal-reject">Reject</Button
				>
				<Button
					variant="ghost"
					icon="pencil"
					disabled={!onrevise || !open}
					onclick={() => open && onrevise?.()}
					data-testid="proposal-revise">Ask for changes</Button
				>
			</div>
			{@render hint('Nothing changes until you accept.')}
		{:else if state.kind === 'applied'}
			<p class="outcome">
				<Badge tone="positive" icon="check">{state.words}</Badge>
				{#if versionHref}
					<span class="dot" aria-hidden="true">·</span>
					<a class="view" href={versionHref} data-testid="proposal-version"
						>View in Train <Icon name="chevron-right" size={14} /></a
					>
				{/if}
			</p>
		{:else if state.kind === 'waiting'}
			{#if state.href}
				<a class="view" href={state.href} data-testid="proposal-review"
					><Badge tone="accent" icon="clock">{state.words}</Badge>
					<Icon name="chevron-right" size={14} /></a
				>
			{:else}
				<Badge tone="accent" icon="clock">{state.words}</Badge>
			{/if}
		{:else if state.kind === 'superseded'}
			<Badge tone="warning" icon="alert">Superseded</Badge>
			<p class="quiet" data-testid="proposal-superseded-reason">
				<!-- The words, the dot and the link are siblings, so the spaces between them stay. -->
				{#if state.link}
					{state.words}
					<span class="dot" aria-hidden="true">·</span>
					<a class="view" href={state.link.href} data-testid="proposal-review"
						>{#if state.link.words === OPEN_REVIEW}{state.link.words}
							<span class="visually-hidden">the review</span>{:else}{state.link.words}{/if}</a
					>
				{:else}
					{state.words}
				{/if}
			</p>
		{:else}
			<Badge tone="neutral">{state.words}</Badge>
		{/if}
	</footer>
	<p class="visually-hidden" role="status">
		{state.kind !== 'proposed' && state.kind !== 'choose'
			? `${card.title}: ${state.words}`
			: accepting
				? 'Accepting…'
				: rejecting
					? 'Rejecting…'
					: ''}
	</p>
</article>

<style>
	.proposal {
		display: grid;
		gap: var(--space-4);
		min-width: 0;
		padding: var(--space-4);
		border-radius: var(--radius-lg);
		border: 1px solid var(--color-border);
		border-left: 3px solid var(--color-accent);
		background: var(--color-surface-1);
	}

	.proposal:not([data-status='proposed']) {
		border-left-color: var(--color-border-strong);
	}

	.head,
	.part {
		display: grid;
		gap: var(--space-1-5);
		min-width: 0;
	}

	.eyebrow,
	.label {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1-5);
		color: var(--color-text-secondary);
		font-size: var(--text-xs);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-caps);
		text-transform: uppercase;
	}

	.title {
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
		letter-spacing: var(--tracking-tight);
		line-height: var(--leading-snug);
		overflow-wrap: anywhere;
	}

	.why,
	.impact {
		color: var(--color-text);
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
		overflow-wrap: anywhere;
	}

	.impact {
		display: grid;
		gap: var(--space-1);
		margin: 0;
		padding-left: var(--space-4);
	}

	.quiet {
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
	}

	.warning {
		display: flex;
		align-items: baseline;
		gap: var(--space-1-5);
		color: var(--color-text);
		font-size: var(--text-sm);
	}

	.mark {
		display: inline-flex;
		align-self: center;
		color: var(--color-warning);
	}

	.foot {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2) var(--space-3);
		padding-top: var(--space-3);
		border-top: 1px solid var(--color-border);
	}

	.actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}

	/* The review link's label is long: on a phone it wraps inside the card, not past its edge. */
	.actions.choose > :global(.btn) {
		max-width: 100%;
		white-space: normal;
		text-align: center;
	}

	.failure {
		width: 100%;
	}

	.retry {
		display: block;
		margin-top: var(--space-2);
	}

	.offline {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1-5);
	}

	.outcome {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
	}

	.dot {
		color: var(--color-text-tertiary);
	}

	.origin {
		justify-self: start;
		font-weight: var(--weight-medium);
	}

	.view {
		display: inline-flex;
		align-items: center;
		gap: var(--space-0-5);
		min-height: var(--touch-target);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		color: var(--color-accent-text);
	}

	.view:focus-visible {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
		border-radius: var(--radius-xs);
	}

	@media (hover: hover) and (pointer: fine) {
		.view:hover {
			text-decoration: underline;
			text-underline-offset: 3px;
		}
	}
</style>
