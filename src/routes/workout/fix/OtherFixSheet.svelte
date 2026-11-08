<!--
  @component
  Fix for a refused other.log (fix/other.ts), in a BottomSheet (a centred dialog from 1024 px):
  why the server refused it first, then the session's fields as the session view asks for them
  (SessionFields), holding the values the change carries, with the server's errors at their
  fields; a metric's error sits at that metric, which can be removed when its plan lacks it. Save
  checks the values as the view does, then hands back the change with them, under the same id;
  the sync sheet checks it and re-queues it in its place. Discard is the sync sheet's.
-->
<script lang="ts">
	import type { OtherFields } from '#lib/domain/workout/index.ts';
	import BottomSheet from '#lib/ui/components/BottomSheet.svelte';
	import Button from '#lib/ui/components/Button.svelte';
	import {
		checkValues,
		logMutation,
		serverErrors,
		templateOf,
		type SessionErrors
	} from '../session/session-log.ts';
	import SessionFields from '../session/SessionFields.svelte';
	import type { FixEditorProps } from './registry.ts';

	let { open = $bindable(), m, problem, errors = {}, view, onsave }: FixEditorProps = $props();

	const given = $derived(m.payload as OtherFields);
	/** The plan's metrics when this is the workout on screen; else any metric may go. */
	const template = $derived(view && view.workout.id === m.workoutId ? templateOf(view) : null);

	let changed = $state.raw<Partial<OtherFields>>({});
	const values = $derived<OtherFields>({ ...given, ...changed });
	let local = $state.raw<SessionErrors | null>(null);
	const shown = $derived(local ?? serverErrors(errors, given.metrics));

	function edit(change: Partial<OtherFields>) {
		changed = { ...changed, ...change };
		const kept = { ...shown };
		for (const key of Object.keys(change)) delete kept[key];
		if (change.metrics) {
			const keys = new Set(change.metrics.map((metric) => `metric:${metric.key}`));
			for (const key of Object.keys(kept))
				if (key.startsWith('metric:') && !keys.has(key)) delete kept[key];
		}
		local = kept;
	}

	function save() {
		const failed = checkValues(values, template);
		if (Object.keys(failed).length > 0) return void (local = failed);
		const next = logMutation(m.workoutId, values, m.at, template);
		onsave({ ...m, payload: next.payload } as typeof m);
		open = false;
	}
</script>

<BottomSheet
	bind:open
	title="Fix the session"
	description="Its type, time, effort, metrics and notes"
	data-testid="other-fix"
>
	<p class="fix" data-testid="fix-reason">Not synced · {problem}</p>
	<SessionFields {values} errors={shown} {template} onchange={edit} />

	{#snippet footer()}
		<Button block icon="check" onclick={save} data-testid="save-fix">Save</Button>
	{/snippet}
</BottomSheet>

<style>
	.fix {
		margin-bottom: var(--space-4);
		color: light-dark(color-mix(in srgb, var(--color-warning) 82%, #000), var(--color-warning));
		font-weight: var(--weight-medium);
	}
</style>
