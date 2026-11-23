<!--
  @component
  Profile's whole list (Paper, 9 · Profile): the training-profile sections in two groups, You and
  Training, then App's Appearance and Security's Passkeys and recovery. Each is a `ListRow` link
  with its answer at its end ("kg, km", "Dark", "2 passkeys"), streamed from the Profile layout's
  load (./answers.ts), or this device's theme once the page has mounted; until then a row shows its
  title alone. From 1024 px (Paper, 14 · "Profile, goals") the list is up to 400 px of 44 px rows with no
  chevrons, no visible group headings and its answers in tertiary, beside the open screen, the open
  row `aria-current`. Words only (./sections.ts), never the editor registry, so no route carries
  an editor in its initial JavaScript.
-->
<script lang="ts">
	import { resolve } from '$app/paths';
	import ListRow from '../components/ListRow.svelte';
	import type { ProfileAnswers } from './answers';
	import { SECTION_GROUPS, sectionsIn, type SectionKey } from './sections';

	interface Props {
		/** Each row's answer, once the server has sent it; rows show their titles until then. */
		answers?: ProfileAnswers | null;
		/** Appearance's answer: this device's theme in words, once the page has mounted. */
		theme?: string;
		/** The row open beside the list, if any. */
		current?: SectionKey | 'appearance' | 'security';
	}

	let { answers = null, theme, current }: Props = $props();
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
	<section class="group" aria-labelledby="{id}-app">
		<h2 class="label" id="{id}-app">App</h2>
		<ListRow
			title="Appearance"
			value={theme}
			href={resolve('/(app)/profile/appearance')}
			aria-current={here('appearance')}
			data-testid="appearance-link"
		/>
	</section>
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

	/*
	 * At a desk (Paper, 14 · "Profile, goals"): 44 px rows with no chevron and the answer in
	 * tertiary, 20 px between groups, the headings kept for assistive tech only. These reach into
	 * ListRow's own class names (.row, .chevron, .value; ../components/ListRow.svelte): a
	 * `compact` prop there would spread to every row, for one screen's list.
	 */
	@media (width >= 64rem) {
		.profile-list {
			gap: var(--space-5);
		}

		.label {
			position: absolute;
			width: 1px;
			height: 1px;
			overflow: hidden;
			clip-path: inset(50%);
			white-space: nowrap;
		}

		/* Through .group, so (0,3,0) beats ListRow's own .row padding whatever order the
		   stylesheets load in. */
		.profile-list .group :global(.row) {
			min-height: var(--touch-target);
			padding-block: 0;
		}

		.profile-list :global(.row .chevron) {
			display: none;
		}

		.profile-list :global(.row .value) {
			color: var(--color-text-tertiary);
		}
	}
</style>
