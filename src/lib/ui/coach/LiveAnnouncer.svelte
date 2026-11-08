<!--
  @component
  What a screen reader hears while an answer streams: each block once it is complete, then
  'Answer complete'. Never tokens, which would talk over the owner. A polite log, so each new
  line is read once, in order, and two blocks that complete together are both read; blocks the
  answer already had when this mounted are not read again.
-->
<script lang="ts">
	import type { CompletedBlock } from '#lib/domain/coach/index.ts';
	import { ANSWER_COMPLETE, blockAnnouncement } from './answer-words.ts';

	interface Props {
		/** The answer's completed blocks, in order. */
		blocks: readonly CompletedBlock[];
		/** The turn's answer_completed arrived. */
		complete?: boolean;
	}

	let { blocks, complete = false }: Props = $props();

	const lines = $derived([
		...blocks.map((b) => ({ key: `block-${b.block}`, text: blockAnnouncement(b) })),
		...(complete ? [{ key: 'complete', text: ANSWER_COMPLETE }] : [])
	]);
</script>

<div
	class="visually-hidden"
	role="log"
	aria-live="polite"
	aria-label="Coach answer updates"
	data-testid="answer-announcer"
>
	{#each lines as line (line.key)}<p>{line.text}</p>{/each}
</div>
