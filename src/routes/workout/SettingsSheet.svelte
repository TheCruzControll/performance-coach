<!--
  @component
  The workout settings (PRD §8), from the workout menu: the rest per exercise type when a
  prescription names none, then whether a completed set starts the rest, the tone, the vibration
  and keeping the screen awake, each only where this browser can do it (settings-rows.ts). Every
  change is kept on this device at once (settings.ts) and the workout reads it at its next set,
  so there is no Save; storage that cannot keep it says so, and the change still applies to this
  page. A BottomSheet: a centred dialog from 1024 px, every control a primitive with its 44 px
  target, hover and :focus-visible states (NumberStepper's keys, Toggle's Space). The workout
  menu loads it when asked for.
-->
<script lang="ts">
	import { feedbackSupport } from '#lib/client/workout/feedback.ts';
	import {
		readWorkoutSettings,
		REST_SETTING_LIMITS,
		writeWorkoutSettings,
		type WorkoutSettingsChange
	} from '#lib/client/workout/settings.ts';
	import { formatDuration, parseDuration } from '#lib/domain/units.ts';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import Notice from '#lib/ui/components/Notice.svelte';
	import NumberStepper from '#lib/ui/components/NumberStepper.svelte';
	import Toggle from '#lib/ui/components/Toggle.svelte';
	import { REST_CLASS_WORDS } from '#lib/ui/workout/rest-words.ts';
	import { toggleRows } from './settings-rows.ts';

	interface Props {
		open: boolean;
	}

	let { open = $bindable() }: Props = $props();

	const id = $props.id();
	const rows = toggleRows(feedbackSupport());
	let settings = $state.raw(readWorkoutSettings());
	let notSaved = $state(false);

	// Read again on each opening: another tab may have changed them meanwhile.
	$effect(() => {
		if (open) settings = readWorkoutSettings();
	});

	function save(change: WorkoutSettingsChange) {
		const written = writeWorkoutSettings(change);
		settings = written.settings;
		notSaved = !written.saved;
	}
</script>

<BottomSheet
	bind:open
	title="Workout settings"
	description="Kept on this device."
	data-testid="workout-settings"
>
	<div class="settings">
		<section class="group" aria-labelledby="{id}-rest">
			<div class="head">
				<h3 id="{id}-rest" class="title">Rest when none is prescribed</h3>
				<p class="lead">A rest your plan prescribes always wins.</p>
			</div>
			<div class="rests">
				{#each REST_CLASS_WORDS as row (row.restClass)}
					<NumberStepper
						value={settings.rest[row.restClass]}
						label={row.label}
						hint={row.hint}
						min={REST_SETTING_LIMITS.min}
						max={REST_SETTING_LIMITS.max}
						step={15}
						bigStep={60}
						chars={4}
						format={formatDuration}
						parse={parseDuration}
						onchange={(seconds) => save({ rest: { [row.restClass]: seconds } })}
						data-testid="rest-{row.restClass}"
					/>
				{/each}
			</div>
		</section>
		<section class="group" aria-labelledby="{id}-timer">
			<h3 id="{id}-timer" class="title">Rest timer</h3>
			<div class="toggles">
				{#each rows as row (row.key)}
					<Toggle
						label={row.label}
						description={row.description}
						checked={settings[row.key]}
						onchange={(on) => save({ [row.key]: on })}
						data-testid="setting-{row.key}"
					/>
				{/each}
			</div>
		</section>
		{#if notSaved}
			<Notice tone="warning" title="Not saved on this device" data-testid="settings-not-saved">
				This browser can't keep settings. They apply until you leave this page.
			</Notice>
		{/if}
	</div>
</BottomSheet>

<style>
	.settings {
		display: grid;
		gap: var(--space-8);
	}

	.group {
		display: grid;
		gap: var(--space-4);
	}

	.head {
		display: grid;
		gap: var(--space-1);
	}

	.title {
		font-size: var(--text-base);
		font-weight: var(--weight-semibold);
		line-height: var(--leading-snug);
		color: var(--color-text);
	}

	.lead {
		font-size: var(--text-sm);
		line-height: var(--leading-normal);
		color: var(--color-text-secondary);
	}

	/* One per row on a phone; two side by side where the dialog has room (desktop). */
	.rests {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
		gap: var(--space-6) var(--space-4);
	}

	.toggles {
		display: grid;
		gap: var(--space-3);
	}
</style>
