<!--
  @component
  'Thinking…' while the coach works out its answer, before its first step or words arrive: three
  dots that pulse in turn beside the words, in CSS alone. The words carry the state; under
  reduced motion the dots hold still.
-->
<script lang="ts">
	let { 'data-testid': testId }: { 'data-testid'?: string } = $props();
</script>

<p class="thinking" role="status" data-testid={testId}>
	<span class="dots" aria-hidden="true"><span></span><span></span><span></span></span>
	<span class="words">Thinking…</span>
</p>

<style>
	.thinking {
		display: inline-flex;
		align-items: center;
		gap: var(--space-2);
		min-height: 1.75rem;
		color: var(--color-text-secondary);
		font-size: var(--text-sm);
	}

	.dots {
		display: inline-flex;
		gap: 0.25rem;
	}

	.dots span {
		width: 0.375rem;
		height: 0.375rem;
		border-radius: 50%;
		background: var(--color-accent);
		animation: pulse 1.2s ease-in-out infinite;
	}

	.dots span:nth-child(2) {
		animation-delay: 0.15s;
	}

	.dots span:nth-child(3) {
		animation-delay: 0.3s;
	}

	@keyframes pulse {
		0%,
		60%,
		100% {
			opacity: 0.3;
			transform: scale(0.8);
		}
		30% {
			opacity: 1;
			transform: scale(1);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.dots span {
			animation: none;
			opacity: 0.6;
		}
	}
</style>
