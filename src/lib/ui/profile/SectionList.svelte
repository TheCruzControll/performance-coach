<!--
  @component
  The training-profile sections as rows, each a link to its editor at /profile/[section]: Profile
  lists them, and from 1024 px a section's screen keeps them beside its editor with the open one
  marked `aria-current`. Words only (./sections.ts), never the editor registry, so neither route
  carries an editor in its initial JavaScript.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import ListRow from '../components/ListRow.svelte';
	import { SECTIONS, type SectionKey } from './sections';

	interface Props {
		/** The section open beside the list, if any. */
		current?: SectionKey;
	}

	let { current }: Props = $props();
</script>

{#each SECTIONS as section (section.key)}
	<ListRow
		title={section.title}
		subtitle={section.subtitle}
		icon={section.icon}
		href={resolve('/(app)/profile/[section]', { section: section.key })}
		aria-current={section.key === current ? 'page' : undefined}
		data-testid="section-{section.key}"
	/>
{/each}
