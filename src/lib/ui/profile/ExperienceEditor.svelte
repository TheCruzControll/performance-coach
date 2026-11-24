<!--
  @component
  Profile → Experience (Paper, 9 · "Experience", "A discipline"): the owner's level in each
  discipline they train, so the coach starts each one at the right level. One row per
  discipline with its level, opening a sheet that holds the level, then years and current
  sessions a week (both optional) as fields, and Remove. Disciplines of open goals are listed
  already. "Add something else you train" asks what it is first, from a sheet, then opens the new
  one's own; a custom one needs a name. Rows are keyed, so removing one never hands its state or
  its errors to the next.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import {
		DISCIPLINE_INFO,
		EXPERIENCE_LEVELS,
		EXPERIENCE_LEVEL_INFO,
		disciplineLabel,
		type Discipline
	} from '#lib/domain/profile/catalog.ts';
	import type { FieldErrors } from '#lib/domain/profile/schemas.ts';
	import BottomSheet from '../components/BottomSheet.svelte';
	import Button from '../components/Button.svelte';
	import ChoiceGroup from '../components/ChoiceGroup.svelte';
	import ListRow from '../components/ListRow.svelte';
	import NumberField from '../components/NumberField.svelte';
	import SheetRow from '../components/SheetRow.svelte';
	import TextField from '../components/TextField.svelte';
	import type { EditorProps } from './editors';
	import {
		addableDisciplines,
		blankExperience,
		errorsByRow,
		levelValue,
		type ExperienceDraft,
		type ExperienceState
	} from './experience';

	let { value = $bindable(), errors = {} }: EditorProps<ExperienceState> = $props();

	const levels = EXPERIENCE_LEVELS.map((l) => ({ value: l, ...EXPERIENCE_LEVEL_INFO[l] }));
	const addable = $derived(
		addableDisciplines(value.entries).map((d) => ({
			value: d,
			label: d === 'custom' ? 'Something else' : DISCIPLINE_INFO[d].short
		}))
	);
	const nameOf = (entry: ExperienceDraft) =>
		disciplineLabel(entry.discipline, entry.customLabel?.trim());

	/**
	 * A save's errors, pinned to the rows that were there when they came back (and only then:
	 * not again when rows come and go), so a row removed afterwards takes its errors with it
	 * instead of handing them to the row that moves up.
	 */
	let pinnedFrom: FieldErrors | undefined;
	let pinned: Record<string, FieldErrors> = {};
	const rowErrors = $derived.by(() => {
		if (errors !== pinnedFrom) {
			pinnedFrom = errors;
			pinned = errorsByRow(errors, value.entries);
		}
		return pinned;
	});
	/** The row's one red line: the first error in its sheet's order. */
	const firstError = (own: FieldErrors) =>
		own.customLabel ?? own.level ?? own.years ?? own.sessionsPerWeek;

	let root = $state<HTMLElement>();
	/** The entry whose sheet is open: its row opened it, or it was just added. */
	let opened = $state<string | null>(null);
	let adding = $state(false);
	let choice = $state<Discipline | null>(null);

	let announcement = $state('');
	let timer: ReturnType<typeof setTimeout> | undefined;

	/** Clear, then set: a live region speaks only when its text changes, even to the same words. */
	function announce(text: string) {
		announcement = '';
		clearTimeout(timer);
		timer = setTimeout(() => (announcement = text), 100);
	}

	const rows = () => [
		...(root?.querySelectorAll<HTMLElement>('[data-testid="experience-entry"]') ?? [])
	];
	const byTestId = (testId: string) =>
		root?.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

	/** Resolves once `dialog` has closed (at once if it is not open). */
	function closed(dialog: HTMLDialogElement | null | undefined): Promise<void> {
		return new Promise((resolve) => {
			if (!dialog?.open) resolve();
			else dialog.addEventListener('close', () => resolve(), { once: true });
		});
	}

	function startAdding() {
		choice = null;
		adding = true;
	}

	/** A discipline picked from "What else do you train?": listed, then its own sheet opens. */
	async function add(discipline: Discipline) {
		if (!adding) return;
		adding = false;
		const entry = blankExperience(discipline, value.entries);
		value.entries.push(entry);
		announce(
			discipline === 'custom'
				? 'Added another discipline'
				: `Added ${DISCIPLINE_INFO[discipline].label}`
		);
		// Once the question has gone, the new row takes the focus, so its sheet hands it back there.
		await closed(root?.querySelector<HTMLDialogElement>('[data-testid="add-discipline-sheet"]'));
		await tick();
		rows()[value.entries.findIndex((e) => e.key === entry.key)]?.focus();
		opened = entry.key;
	}

	/** An arrow key is moving the pick: the change it fires adds nothing. */
	let stepping = false;
	const isRadio = (target: EventTarget | null): target is HTMLInputElement =>
		target instanceof HTMLInputElement && target.type === 'radio';

	function picked() {
		const stepped = stepping;
		stepping = false;
		if (!stepped && choice) void add(choice);
	}

	/** Arrows step through the disciplines; Enter or Space adds the focused one. */
	function onAddKey(event: KeyboardEvent) {
		if (!isRadio(event.target)) return;
		stepping = event.key.startsWith('Arrow');
		if (event.key !== 'Enter' && event.key !== ' ') return;
		event.preventDefault();
		void add(event.target.value as Discipline);
	}

	/** A tap adds the discipline, also one an arrow key had stepped to (it fires no change). */
	function onAddClick(event: MouseEvent) {
		if (isRadio(event.target) && event.detail > 0) void add(event.target.value as Discipline);
	}

	async function remove(key: string) {
		const index = value.entries.findIndex((e) => e.key === key);
		if (index === -1) return;
		const entry = value.entries[index]!;
		opened = null;
		value.entries.splice(index, 1);
		// Its errors go with it: a row added later under the same key starts without them.
		delete pinned[key];
		announce(`Removed ${nameOf(entry)}`);
		// Its row went with its sheet: the focus takes its place, on the next row, the one before,
		// or the way to add one.
		await tick();
		const left = rows();
		(left[index] ?? left[index - 1] ?? byTestId('add-discipline'))?.focus();
	}
</script>

<div class="experience" bind:this={root}>
	{#if value.entries.length}
		<div class="rows">
			{#each value.entries as entry (entry.key)}
				{@const name = nameOf(entry)}
				{@const own = rowErrors[entry.key] ?? {}}
				<SheetRow
					label={name}
					value={levelValue(entry)}
					placeholder="Choose"
					error={firstError(own)}
					bind:open={() => opened === entry.key, (open) => (opened = open ? entry.key : null)}
					data-testid="experience-entry"
				>
					{#if entry.discipline === 'custom'}
						<TextField
							label="What is it?"
							bind:value={() => entry.customLabel ?? '', (v) => (entry.customLabel = v || null)}
							error={own.customLabel}
							placeholder="Climbing, BJJ, rowing…"
							maxlength={40}
							autocapitalize="sentences"
							enterkeyhint="next"
						/>
					{/if}
					<ChoiceGroup
						legend="Level"
						hideLegend
						variant="card"
						hintPlacement="end"
						options={levels}
						bind:value={entry.level}
						error={own.level}
					/>
					<!-- Years and sessions are fields here, not rows opening a sheet over the sheet. -->
					<div class="pair">
						<NumberField
							label="Years"
							hint="Roughly is fine"
							bind:value={entry.years}
							error={own.years}
							optional
							enterkeyhint="next"
						/>
						<NumberField
							label="Sessions"
							unit="a week"
							integer
							bind:value={entry.sessionsPerWeek}
							error={own.sessionsPerWeek}
							optional
						/>
					</div>
					<ListRow
						title="Remove {name}"
						danger
						onclick={() => remove(entry.key)}
						data-testid="experience-remove"
					/>
				</SheetRow>
			{/each}
		</div>
	{/if}
	{#if errors.entries}<p class="error" role="alert">{errors.entries}</p>{/if}
	<!-- A text link as wide as its words (Paper), 8 px under the last row. -->
	<div class="more">
		<Button variant="link" onclick={startAdding} data-testid="add-discipline">
			Add something else you train
		</Button>
	</div>

	<BottomSheet
		bind:open={adding}
		title="What else do you train?"
		data-testid="add-discipline-sheet"
	>
		<!-- The radios' keys and clicks bubble here: the group itself is the native one. -->
		<div
			role="presentation"
			onkeydown={onAddKey}
			onclick={onAddClick}
			onpointerdown={() => (stepping = false)}
		>
			<ChoiceGroup
				legend="What else do you train?"
				hideLegend
				variant="card"
				options={addable}
				bind:value={choice}
				onchange={picked}
			/>
		</div>
	</BottomSheet>

	<p class="visually-hidden" role="status">{announcement}</p>
</div>

<style>
	.experience,
	.rows {
		display: grid;
	}

	.more {
		padding-top: var(--space-2);
	}

	.pair {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: var(--space-3);
		align-items: start;
	}

	/* An error about the whole list: one red line under it. */
	.error {
		font: var(--type-caption);
		color: var(--color-danger);
	}
</style>
