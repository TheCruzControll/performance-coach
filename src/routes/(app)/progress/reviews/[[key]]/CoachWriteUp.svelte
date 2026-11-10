<!--
  @component
  The coach's write-up on a weekly or cycle review (review-narrative-ui), after the figures, which
  it never moves or blocks. The server renders its frame: the stored released text, 'Your coach
  is writing this up…', or why there is none, in a box reserved at six lines, with 'Discuss with
  your coach'. After hydration WriteUpLive takes its place with the same layout (the request, the
  polls, Retry, M5's AnswerBlocks), loaded as a chart's frame is, so neither its code nor its
  styles are initial JS or render-blocking CSS. Without JavaScript the frame is what shows.
-->
<script lang="ts">
	import Button from '#lib/ui/components/Button.svelte';
	import type { Narration } from './load';

	let { narration }: { narration: Narration } = $props();
	// The m6-plan budget lever: the live part's code and styles load after hydration.
	const never = () => new Promise<never>(() => {});
	const live = import.meta.env.SSR ? never() : import('./WriteUpLive.svelte');
</script>

{#snippet frame()}
	<section class="write-up" aria-labelledby="write-up-title" data-testid="review-write-up">
		<h3 id="write-up-title">Your coach’s write-up</h3>
		<div class="box">
			{#each narration.lines as line, i (i)}<p>{line}</p>{/each}
		</div>
		<div>
			<Button variant="secondary" size="sm" icon="coach" href={narration.discuss}
				>Discuss with your coach</Button
			>
		</div>
	</section>
{/snippet}

{#await live}
	{@render frame()}
{:then { default: Live }}
	<!-- A refresh keeps the page's key: the live revision's write-up starts afresh. -->
	{#key narration.target.id}<Live {narration} />{/key}
{/await}

<style>
	.write-up {
		display: grid;
		gap: var(--space-3);
		padding: var(--space-4);
		border: 1px solid var(--color-border);
		border-radius: var(--radius-lg);
	}

	h3 {
		font-size: var(--text-lg);
		font-weight: var(--weight-semibold);
	}

	.box {
		display: grid;
		gap: var(--space-2);
		align-content: start;
		height: calc(6em * var(--leading-normal));
		overflow: hidden;
	}

	/* Without JavaScript there is no 'Read all': the whole write-up shows. */
	@media (scripting: none) {
		.box {
			height: auto;
		}
	}
</style>
