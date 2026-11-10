<!--
  @component
  PRD §12's example questions as `.prompt` rows, directly under the header: one column on a
  phone, two from 1024 px. At 393 × 659 every row ends above the composer (e2e/shell.e2e.ts).
  They are words, not buttons, until coach-thread-stream makes each one fill the composer.
-->
<script lang="ts">
	import Icon from '#lib/ui/components/Icon.svelte';

	/** PRD §12's examples that fit one line on a phone; M2X's specs count four. */
	const SUGGESTIONS = [
		'How has my bench progressed this month?',
		'Should I increase my squat weight?',
		'How is my running affecting my lifting?',
		'What should I focus on next week?'
	];
</script>

<section aria-labelledby="prompts-heading">
	<h2 id="prompts-heading" class="eyebrow title">Things you can ask</h2>
	<ul class="prompts">
		{#each SUGGESTIONS as prompt (prompt)}
			<li class="prompt"><Icon name="coach" size={18} />{prompt}</li>
		{/each}
	</ul>
</section>

<style>
	.title {
		margin-bottom: var(--space-2);
	}

	.prompts {
		display: grid;
		gap: var(--space-1-5);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.prompt {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		min-height: 2.5rem;
		padding: var(--space-2) var(--space-4);
		border-radius: var(--radius-lg);
		border: 1px dashed var(--color-border-strong);
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.prompt :global(.icon) {
		color: var(--color-text-tertiary);
	}

	/* The column stays readable, as a conversation should; the suggestions pair up in it. */
	@media (width >= 64rem) {
		.prompts {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: var(--space-2);
		}
	}
</style>
