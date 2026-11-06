<!--
  @component
  Asks before leaving a Profile section with unsaved changes: discard them and go on, or keep
  editing. It loads with the section's editor, so the screen carries no sheet until then.
-->
<script lang="ts">
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import Button from '#lib/ui/components/Button.svelte';

	interface Props {
		open: boolean;
		/** The section's title, e.g. "Equipment". */
		section: string;
		ondiscard: () => void;
	}

	let { open = $bindable(), section, ondiscard }: Props = $props();
</script>

<BottomSheet
	bind:open
	title="Discard your changes?"
	description="Your changes to {section} haven’t been saved."
	data-testid="discard-sheet"
>
	<div class="choices">
		<Button variant="danger" block onclick={ondiscard} data-testid="discard-changes">
			Discard changes
		</Button>
		<Button variant="ghost" block onclick={() => (open = false)} data-testid="keep-editing">
			Keep editing
		</Button>
	</div>
</BottomSheet>

<style>
	.choices {
		display: grid;
		gap: var(--space-3);
		padding-bottom: var(--space-2);
	}
</style>
