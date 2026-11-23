<!--
  @component
  Add a session to a planned week of Train's program: the BottomSheet it holds, code-split out of
  Train's initial JavaScript (Train loads it on the day's Add session button). The owner picks the
  kind, the day (among `addable`, defaulting to the day Train shows), the time of day (or any), the
  effort (easy, moderate or hard: the kind's default first) and, optionally, the length and a reason.
  Save posts ?/addSession with the version the sheet was opened on, and the program service builds
  the session from the owner's profile and writes the next version.

  A refusal is said under its field (a day that has passed, a day outside the program, a full day,
  a length the session cannot take). A new week finding never blocks the add: the toast counts it.
  A stale version is a conflict, which Reload clears. Validation (zod) runs in the sheet first, as
  SkipSheet's does; the server checks again.
  On success the sheet closes (and `onadded` runs: Train closes More, which it opened over, so the
  new line is in view) and a toast names the session and its day, with its version and any
  findings to look at, and links to History.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { applyAction, type ActionResult } from '$app/forms';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { focusFirstError, post } from '#lib/client/profile-form.ts';
	import { weekdayOf, type IsoDate } from '#lib/domain/calendar.ts';
	import { TIME_OF_DAY_LABEL, TIMES_OF_DAY, WEEKDAY_INFO } from '#lib/domain/profile/catalog.ts';
	import {
		ADD_INTENTS,
		ADDED_KINDS,
		addSessionSchema,
		REASON_MAX,
		type AddedKind,
		type AddIntent
	} from '#lib/domain/training/edits.ts';
	import { validate, type FieldErrors } from '#lib/domain/validation.ts';
	import BottomSheet from '../components/BottomSheet.svelte';
	import Button from '../components/Button.svelte';
	import ChoiceGroup from '../components/ChoiceGroup.svelte';
	import Notice from '../components/Notice.svelte';
	import NumberField from '../components/NumberField.svelte';
	import SegmentedControl from '../components/SegmentedControl.svelte';
	import TextArea from '../components/TextArea.svelte';
	import { toast } from '../toast.svelte';
	import { shortDate } from './words.ts';

	interface Props {
		open: boolean;
		/** The version the sheet was opened on: the add is made on it. */
		version: number;
		/** The days of the week an add can take (WeekView.addable). */
		addable: readonly IsoDate[];
		/** The day Train shows: the day the sheet starts on when it can take an add. */
		day: IsoDate;
		/** The effort each kind takes until the owner picks one (WeekView's rule, from the server). */
		addIntents: Record<AddedKind, AddIntent>;
		onclose: () => void;
		/** An add was saved: the sheet has closed. */
		onadded?: () => void;
	}

	/** What the server says an add made: its version, the built title and the week's new findings. */
	interface Added {
		version: number;
		title: string;
		warnings: { severity: string; message: string }[];
	}

	let { open = $bindable(), version, addable, day, addIntents, onclose, onadded }: Props = $props();

	const UNREACHABLE = 'Can’t reach the server. Check your connection, then try again.';
	const NOT_SAVED = 'That didn’t save. Try again.';
	/** Field errors shown beside their own input; the others (kind, effort) in one notice. */
	const INLINE = ['date', 'timeOfDay', 'durationMinutes', 'reason'];

	const KIND_LABEL: Record<AddedKind, string> = {
		strength: 'Strength',
		hypertrophy: 'Hypertrophy',
		run: 'Run',
		muay_thai: 'Muay Thai',
		conditioning: 'Conditioning'
	};
	const INTENT_LABEL: Record<AddIntent, string> = {
		easy: 'Easy',
		moderate: 'Moderate',
		hard: 'Hard'
	};

	const kindOptions = ADDED_KINDS.map((value) => ({ value, label: KIND_LABEL[value] }));
	const intentOptions = ADD_INTENTS.map((value) => ({ value, label: INTENT_LABEL[value] }));
	const dayOptions = $derived(addable.map((value) => ({ value, label: shortDate(value) })));
	/** 'It varies' is how a plan words a session's time, not a time the owner picks for an add. */
	const timeOptions = [
		{ value: 'any', label: 'Any time' },
		...TIMES_OF_DAY.filter((value) => value !== 'varies').map((value) => ({
			value,
			label: TIME_OF_DAY_LABEL[value]
		}))
	];

	let kind = $state<AddedKind>('strength');
	let intent = $state<AddIntent>('moderate');
	let date = $state<IsoDate | null>(null);
	let time = $state<string>('any');
	let minutes = $state<number | null>(null);
	let reason = $state<string | null>('');
	let errors = $state<FieldErrors>({});
	let failure = $state<string | null>(null);
	/** The page's version is no longer the current one: nothing can be saved from it. */
	let conflict = $state(false);
	let reloading = $state(false);
	let busy = $state(false);
	let fields = $state<HTMLElement>();

	/** Opened: a fresh form, on the day Train shows (else the first day that can take an add). */
	$effect(() => {
		if (!open) return;
		untrack(() => {
			kind = 'strength';
			intent = addIntents.strength;
			date = addable.includes(day) ? day : (addable[0] ?? null);
			time = 'any';
			minutes = null;
			reason = '';
			errors = {};
			failure = null;
			conflict = false;
		});
	});

	/** A refused add: its field errors, a conflict, or a message. */
	function refused(data: Record<string, unknown> | undefined) {
		const found = (data?.errors ?? {}) as FieldErrors;
		if (data?.reason === 'version') conflict = true;
		else if (Object.keys(found).length) {
			errors = found;
			failure = Object.entries(found).find(([field]) => !INLINE.includes(field))?.[1] ?? null;
			focusFirstError(fields);
		} else failure = typeof data?.message === 'string' ? data.message : NOT_SAVED;
	}

	/** Validate, then post the add with the version shown; the toast's words once saved. */
	async function save() {
		if (busy) return;
		failure = null;
		const add = {
			date: date ?? '',
			kind,
			intent,
			timeOfDay: time === 'any' ? undefined : time,
			durationMinutes: minutes ?? undefined,
			reason: reason?.trim() || undefined
		};
		const checked = validate(addSessionSchema, add);
		if (!checked.ok) {
			errors = checked.errors;
			focusFirstError(fields);
			return;
		}
		errors = {};
		busy = true;
		let result: ActionResult;
		try {
			result = await post('?/addSession', { ...add, version });
		} catch {
			failure = UNREACHABLE;
			busy = false;
			return;
		}
		busy = false;
		if (result.type === 'success') {
			const added = result.data as Added;
			const weekday = WEEKDAY_INFO[weekdayOf(checked.data.date)].label;
			const looks = added.warnings.length ? ` · ${added.warnings.length} to look at` : '';
			open = false;
			onadded?.();
			toast.show(`Added ${added.title} on ${weekday} · version ${added.version}${looks}`, {
				tone: 'positive',
				action: {
					label: 'History',
					onclick: () => goto(resolve('/(app)/train/history/[[version]]', {}))
				}
			});
			await invalidateAll();
		} else if (result.type === 'failure') refused(result.data);
		// A redirect or the server's own error: SvelteKit's to handle.
		else await applyAction(result);
	}

	async function reload() {
		reloading = true;
		await invalidateAll();
		reloading = false;
		conflict = false;
	}

	/** A kind sets the effort it is usually meant at, until the owner picks another. */
	function chooseKind(next: AddedKind) {
		intent = addIntents[next];
	}
</script>

<BottomSheet
	bind:open
	title="Add session"
	{onclose}
	footer={saveBar}
	data-testid="add-session-sheet"
>
	<div class="add" bind:this={fields} data-testid="add-session-form">
		<ChoiceGroup
			legend="Kind of session"
			options={kindOptions}
			bind:value={kind}
			onchange={() => chooseKind(kind)}
			data-testid="add-kind"
		/>

		<ChoiceGroup
			legend="Day"
			hint="The days of this week that can take a session."
			options={dayOptions}
			bind:value={date}
			error={errors.date}
			data-testid="add-day"
		/>

		<ChoiceGroup
			legend="Time of day"
			options={timeOptions}
			bind:value={time}
			error={errors.timeOfDay}
			data-testid="add-time"
		/>

		<SegmentedControl
			label="Effort"
			options={intentOptions}
			bind:value={intent}
			data-testid="add-intent"
		/>

		<NumberField
			label="Length"
			unit="min"
			integer
			optional
			bind:value={minutes}
			hint="Left blank, it is the usual length for this kind."
			error={errors.durationMinutes}
			data-testid="add-length"
		/>

		<TextArea
			label="Reason"
			optional
			bind:value={reason}
			error={errors.reason}
			hint="Kept with the change, so you can see later why it was added."
			placeholder="Feeling fresh, a make-up session…"
			maxlength={REASON_MAX}
			rows={2}
			data-testid="add-reason"
		/>

		{#if conflict}
			<Notice tone="warning" title="Your plan changed" data-testid="add-conflict">
				It changed after you opened this sheet, so nothing was added. Reload to see the latest, then
				add it again.
				<div class="reload">
					<Button variant="secondary" size="sm" loading={reloading} onclick={reload}>Reload</Button>
				</div>
			</Notice>
		{/if}
		{#if failure}<Notice tone="danger" data-testid="add-failure">{failure}</Notice>{/if}
	</div>
</BottomSheet>

{#snippet saveBar()}
	<Button block loading={busy} onclick={save} data-testid="add-save">Add session</Button>
{/snippet}

<style>
	.add {
		display: grid;
		gap: var(--space-5);
		padding-bottom: var(--space-2);
	}

	.reload {
		margin-top: var(--space-3);
	}
</style>
