<!--
  @component
  A proposal in the conversation (M5 plan, coach-proposal-cards): its title, what changes (its
  rows), why, and the impact on each week it touches, or that the week's totals stay as they
  were. Nothing changes until Accept; then it says where it went: 'Applied as version N' with a
  link to that version in Train, 'Waits for your cycle review' for an accepted next cycle, or why
  it was superseded. Loaded on demand with the first card a conversation shows. Accept, Reject
  and 'Ask for changes' are the screen's (`onaccept`, `onreject`, `onrevise`); while a decision is
  on its way its button is busy and nothing else can be pressed. A decision that did not go
  through (`failed`) says so in place with Retry (`onretry`), which sends the same decision again:
  the server never applies it twice. Offline, nothing can be decided, and the card says why. The
  outcome is announced.
-->
<script lang="ts">
	import { cardState, type ProposalCardView } from '#lib/domain/coach/cards.ts';
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
		{#if state.kind === 'proposed'}
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
				<p id="{id}-hint" class="quiet">Nothing changes until you accept.</p>
			{/if}
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
			<Badge tone="accent" icon="clock">{state.words}</Badge>
		{:else if state.kind === 'superseded'}
			<Badge tone="warning" icon="alert">Superseded</Badge>
			<p class="quiet">{state.words}</p>
		{:else}
			<Badge tone="neutral">{state.words}</Badge>
		{/if}
	</footer>
	<p class="visually-hidden" role="status">
		{state.kind !== 'proposed'
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
