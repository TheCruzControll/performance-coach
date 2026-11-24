<!--
  @component
  Asks before leaving a Profile section with unsaved changes (Paper, 9 · "Discard changes"): two
  plain rows, Keep editing first, then Discard changes in the danger colour. It loads with the
  section's editor, so the screen carries no sheet until then.
-->
<script lang="ts">
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import ListRow from '#lib/ui/components/ListRow.svelte';

	interface Props {
		open: boolean;
		/** The section's title, e.g. "Equipment". */
		section: string;
		ondiscard: () => void;
	}

	let { open = $bindable(), section, ondiscard }: Props = $props();
</script>

<!-- Both rows plain: no chevron on either (a danger row has none of its own). -->
{#snippet plain()}{/snippet}

<BottomSheet
	bind:open
	title="Discard your changes?"
	description="Your changes to {section} haven’t been saved."
	data-testid="discard-sheet"
>
	<ListRow
		title="Keep editing"
		trailing={plain}
		onclick={() => (open = false)}
		data-testid="keep-editing"
	/>
	<ListRow title="Discard changes" danger onclick={ondiscard} data-testid="discard-changes" />
</BottomSheet>
