<!--
  @component
  The alternatives a quick action offers for an exercise, best first, each one a button: its name,
  why it fits (M3's reasons), what it needs, and its own last top set when it has one. Choosing
  one hands it back. Tab reaches each option, and the arrow keys move between them (Home and End
  to the ends). When nothing fits, it says so and why (the kit's reasons), with Add my own
  exercise and Skip exercise.
  `error` is why the server refused the last choice (Fix), shown above the list.
  Loaded with the actions sheet and the substitute's Fix, never before.
-->
<script lang="ts">
	import { ALTERNATIVES_COPY, needsLine } from '#lib/domain/workout/copy.ts';
	import type { KitAlternative } from '#lib/domain/workout/index.ts';
	import Button from '#lib/ui/components/Button.svelte';
	import { doneText } from '#lib/ui/workout/set-words.ts';

	interface Props {
		alternatives: KitAlternative[];
		/** Why nothing fits, when nothing does. */
		blocked: string[];
		error?: string | null;
		onchoose: (alternative: KitAlternative) => void;
		/** Skip exercise, offered when nothing fits. */
		onskip?: () => void;
		/** Add my own exercise, offered when nothing fits. */
		onaddown?: () => void;
	}

	let { alternatives, blocked, error = null, onchoose, onskip, onaddown }: Props = $props();

	const STEPS: Record<string, (i: number, n: number) => number> = {
		ArrowDown: (i, n) => (i + 1) % n,
		ArrowUp: (i, n) => (i - 1 + n) % n,
		Home: () => 0,
		End: (_, n) => n - 1
	};

	function move(event: KeyboardEvent) {
		const step = STEPS[event.key];
		const options = [
			...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('.option')
		];
		const at = options.indexOf(document.activeElement as HTMLElement);
		if (!step || at < 0) return;
		event.preventDefault();
		options[step(at, options.length)]?.focus();
	}
</script>

{#if error}
	<p class="error" role="alert" data-testid="alternatives-error">Not synced · {error}</p>
{/if}

{#if alternatives.length > 0}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<ul class="list" aria-label="Alternatives" onkeydown={move} data-testid="alternatives">
		{#each alternatives as alternative (alternative.exercise.id)}
			<li>
				<button
					type="button"
					class="option"
					onclick={() => onchoose(alternative)}
					data-testid="alternative"
				>
					<span class="name">{alternative.exercise.name}</span>
					{#if alternative.reasons.length > 0}
						<span class="detail">{alternative.reasons.join(' · ')}</span>
					{/if}
					<span class="detail">{needsLine(alternative.equipment)}</span>
					{#if alternative.lastTopSet}
						<span class="detail">Last top set · {doneText(alternative.lastTopSet)}</span>
					{/if}
				</button>
			</li>
		{/each}
	</ul>
{:else}
	<div class="empty" data-testid="alternatives-empty">
		<p class="title">{ALTERNATIVES_COPY.empty.title}</p>
		<p class="detail">{ALTERNATIVES_COPY.empty.note}</p>
		{#if blocked.length > 0}
			<ul class="reasons" data-testid="alternatives-blocked">
				{#each blocked as reason, i (i)}<li>{reason}</li>{/each}
			</ul>
		{/if}
		{#if onaddown}
			<Button variant="secondary" icon="plus" onclick={onaddown} data-testid="empty-add-own">
				Add my own exercise
			</Button>
		{/if}
		{#if onskip}
			<Button variant="secondary" icon="arrow-right" onclick={onskip} data-testid="empty-skip">
				{ALTERNATIVES_COPY.empty.skip}
			</Button>
		{/if}
	</div>
{/if}

<style>
	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.list {
		display: grid;
		gap: var(--space-2);
	}

	.option {
		display: grid;
		gap: var(--space-0-5);
		width: 100%;
		min-height: 44px;
		padding: var(--space-3);
		border-radius: var(--radius-md);
		border: 1px solid var(--color-border);
		background: var(--color-surface-2);
		color: var(--color-text);
		font: inherit;
		text-align: start;
		cursor: pointer;
		transition:
			border-color var(--duration-fast) var(--ease-standard),
			background-color var(--duration-fast) var(--ease-standard);
	}

	.option:active {
		background: var(--color-surface-3);
	}

	.option:focus-visible {
		outline: 2px solid var(--color-accent-ring);
		outline-offset: 2px;
	}

	@media (hover: hover) and (pointer: fine) {
		.option:hover {
			border-color: var(--color-border-strong);
			background: var(--color-surface-3);
		}
	}

	.name,
	.title {
		font-weight: var(--weight-semibold);
		overflow-wrap: anywhere;
	}

	.detail {
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
		overflow-wrap: anywhere;
	}

	.error {
		margin-bottom: var(--space-3);
		font-size: var(--text-sm);
		color: var(--color-danger);
	}

	.empty {
		display: grid;
		justify-items: start;
		gap: var(--space-2);
		padding: var(--space-4);
		border-radius: var(--radius-md);
		border: 1px dashed var(--color-border-strong);
	}

	.reasons {
		display: grid;
		gap: var(--space-1);
		margin-bottom: var(--space-2);
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.reasons li::before {
		content: '· ';
	}
</style>
