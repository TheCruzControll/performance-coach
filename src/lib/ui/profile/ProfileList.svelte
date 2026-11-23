<!--
  @component
  Profile's whole list (Paper, 9 · Profile): the training-profile sections in two groups, You and
  Training, then Security's Passkeys and recovery. Each is a `ListRow` link with its answer at its
  end ("kg, km", "2 passkeys"), streamed from the Profile layout's load (./answers.ts); until it
  arrives a row shows its title alone. From 1024 px a section's screen keeps the list beside its
  editor, the open row `aria-current`. Words only (./sections.ts), never the editor registry, so
  no route carries an editor in its initial JavaScript.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import ListRow from '../components/ListRow.svelte';
	import type { ProfileAnswers } from './answers';
	import { SECTION_GROUPS, sectionsIn, type SectionKey } from './sections';

	interface Props {
		/** Each row's answer, once the server has sent it; rows show their titles until then. */
		answers?: ProfileAnswers | null;
		/** The row open beside the list, if any. */
		current?: SectionKey | 'security';
	}

	let { answers = null, current }: Props = $props();
	const id = $props.id();
	const here = (key: Props['current']) => (key === current ? 'page' : undefined);
</script>

<div class="profile-list" data-testid="profile-list">
	{#each SECTION_GROUPS as group (group.id)}
		<section class="group" aria-labelledby="{id}-{group.id}">
			<h2 class="label" id="{id}-{group.id}">{group.title}</h2>
			{#each sectionsIn(group.id) as section (section.key)}
				<ListRow
					title={section.title}
					value={answers?.sections[section.key]}
					href={resolve('/(app)/profile/[section]', { section: section.key })}
					aria-current={here(section.key)}
					data-testid="section-{section.key}"
				/>
			{/each}
		</section>
	{/each}
	<section class="group" aria-labelledby="{id}-security">
		<h2 class="label" id="{id}-security">Security</h2>
		<ListRow
			title="Passkeys and recovery"
			value={answers?.passkeys}
			href={resolve('/(app)/profile/security')}
			aria-current={here('security')}
			data-testid="security-link"
		/>
	</section>
</div>

<style>
	/* 36 px between groups; a group's heading sits directly above its first row. */
	.profile-list {
		display: grid;
		gap: var(--space-9);
	}

	.group {
		display: grid;
	}

	.label {
		font: var(--type-secondary);
		color: var(--color-text-tertiary);
	}
</style>
