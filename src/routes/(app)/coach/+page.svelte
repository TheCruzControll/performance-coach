<script lang="ts">
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import Icon from '#lib/ui/components/Icon.svelte';
	import IconButton from '#lib/ui/components/IconButton.svelte';
	import PageHeader from '#lib/ui/components/PageHeader.svelte';

	const prompts = [
		'How has my bench progressed this month?',
		'Should I increase my squat weight?',
		'How is my running affecting my lifting?',
		'What should I focus on next week?'
	];
</script>

<svelte:head>
	<title>Coach · Performance Coach</title>
</svelte:head>

<PageHeader title="Coach" eyebrow="Ask anything" />

<div class="coach">
	<EmptyState
		icon="sparkle"
		title="Your coach is getting ready"
		description="Answers will come from your actual training data — facts, calculated metrics and recommendations, always labelled. Changes it proposes wait for your approval."
		data-testid="coach-empty"
	/>

	<section aria-labelledby="prompts-heading">
		<h2 id="prompts-heading" class="eyebrow prompts-title">Things you'll be able to ask</h2>
		<ul class="prompts">
			{#each prompts as prompt (prompt)}
				<li class="prompt"><Icon name="coach" size={18} />{prompt}</li>
			{/each}
		</ul>
	</section>
</div>

<form class="composer" aria-label="Message your coach" onsubmit={(e) => e.preventDefault()}>
	<label class="visually-hidden" for="coach-input">Message</label>
	<input
		id="coach-input"
		class="composer-input"
		placeholder="Coach arrives in Milestone 5"
		disabled
		autocomplete="off"
	/>
	<IconButton icon="send" label="Send" variant="accent" type="submit" disabled />
</form>

<style>
	.coach {
		display: grid;
		gap: var(--space-4);
		padding-bottom: calc(var(--space-20) + var(--space-4));
	}

	.prompts-title {
		margin-bottom: var(--space-3);
	}

	.prompts {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.prompt {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-3) var(--space-4);
		border-radius: var(--radius-lg);
		border: 1px dashed var(--color-border-strong);
		font-size: var(--text-sm);
		color: var(--color-text-secondary);
	}

	.prompt :global(.icon) {
		color: var(--color-text-tertiary);
	}

	.composer {
		position: fixed;
		z-index: var(--z-sticky);
		left: 50%;
		transform: translateX(-50%);
		bottom: calc(var(--nav-height) + var(--safe-bottom) + var(--space-3));
		width: min(calc(100% - 2 * var(--gutter)), var(--content-max));
		display: flex;
		align-items: center;
		gap: var(--space-2);
		padding: var(--space-1-5) var(--space-1-5) var(--space-1-5) var(--space-4);
		border-radius: var(--radius-full);
		background: var(--color-glass);
		backdrop-filter: blur(18px);
		-webkit-backdrop-filter: blur(18px);
		border: 1px solid var(--color-border);
		box-shadow: var(--elevation-2);
	}

	.composer-input {
		flex: 1;
		min-width: 0;
		height: var(--touch-target);
		border: 0;
		background: transparent;
		font-size: var(--text-base);
	}

	.composer-input::placeholder {
		color: var(--color-text-tertiary);
	}
</style>
