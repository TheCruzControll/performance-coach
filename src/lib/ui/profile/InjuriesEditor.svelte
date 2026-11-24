<!--
  @component
  Profile → Injuries (Paper, 9 · "Injuries", "New injury", "Edit injury"): one row each, with how
  much it limits you at its end, resolved ones under Better now; each opens its own screen
  (a sub-screen, subscreens.svelte.ts) asking where, which side and how much it limits you as
  sheets, what to leave out as one line of words, and any notes, then It's better now and Remove
  this injury. Saved with the section's Save. No injuries is a perfectly good answer. Rows are
  keyed by injury, so removing one never hands its state or its errors to the next.
-->
<script lang="ts">
	import { tick } from 'svelte';
	import {
		BODY_AREAS,
		BODY_AREA_LABEL,
		SEVERITIES,
		SEVERITY_INFO,
		type Side
	} from '#lib/domain/profile/catalog.ts';
	import type { FieldErrors } from '#lib/domain/profile/schemas.ts';
	import Button from '../components/Button.svelte';
	import ListRow from '../components/ListRow.svelte';
	import PickRow from '../components/PickRow.svelte';
	import TextArea from '../components/TextArea.svelte';
	import TextField from '../components/TextField.svelte';
	import type { EditorProps } from './editors';
	import {
		avoidList,
		avoidText,
		errorsByRow,
		injuryRowValue,
		injuryTitle,
		newInjury,
		type InjuriesDraft,
		type InjuryDraft
	} from './injuries';
	import { useSubScreens } from './subscreens.svelte.ts';

	let { value = $bindable(), errors = {} }: EditorProps<InjuriesDraft> = $props();

	const id = $props.id();
	const areas = BODY_AREAS.map((a) => ({ value: a, label: BODY_AREA_LABEL[a] }));
	// Side is optional: "Doesn’t apply" is the choice that stands for none (radios can't clear).
	const NO_SIDE = 'none';
	const sides: { value: Side | typeof NO_SIDE; label: string }[] = [
		{ value: 'left', label: 'Left' },
		{ value: 'right', label: 'Right' },
		{ value: 'both', label: 'Both' },
		{ value: NO_SIDE, label: 'Doesn’t apply' }
	];
	const severities = SEVERITIES.map((s) => ({ value: s, ...SEVERITY_INFO[s] }));

	/** The host's sub-screens: none where an editor is rendered alone (a test). */
	const subs = useSubScreens();
	const SCREEN = 'injury:';

	/** The injury whose own screen is open, if one is. */
	const open = $derived.by(() => {
		const top = subs?.top?.id;
		return top?.startsWith(SCREEN) ? value.injuries.find((i) => SCREEN + i.key === top) : undefined;
	});
	const active = $derived(value.injuries.filter((i) => i.active));
	const resolved = $derived(value.injuries.filter((i) => !i.active));

	/** A row's and its screen's title: "Left knee", or "New injury" until it has an area. */
	const named = (injury: InjuryDraft) => (injury.bodyArea ? injuryTitle(injury) : 'New injury');

	/**
	 * A save's errors, pinned to the rows that were there when they came back (and only then,
	 * not again as rows come and go), so a row removed afterwards takes its errors with it
	 * instead of handing them to the row that moves up.
	 */
	let pinnedFrom: FieldErrors | undefined;
	let pinned: Record<string, FieldErrors> = {};
	const rowErrors = $derived.by(() => {
		if (errors !== pinnedFrom) {
			pinnedFrom = errors;
			pinned = errorsByRow(errors, value.injuries);
		}
		return pinned;
	});

	let root = $state<HTMLElement>();
	let announcement = $state('');
	let timer: ReturnType<typeof setTimeout> | undefined;

	/** Clear, then set: a live region speaks only when its text changes, even to the same words. */
	function announce(text: string) {
		announcement = '';
		clearTimeout(timer);
		timer = setTimeout(() => (announcement = text), 100);
	}

	function edit(injury: InjuryDraft) {
		subs?.open({ id: SCREEN + injury.key, title: named(injury), back: 'Injuries' });
	}

	function add() {
		const added = newInjury(value.injuries);
		value.injuries.push(added);
		announce('Added an injury');
		edit(added);
	}

	/** Better now, or back again: it moves between the lists, and the list shows where it went. */
	function toggleActive(injury: InjuryDraft) {
		injury.active = !injury.active;
		announce(injury.active ? 'Moved back to your injuries' : 'Moved to Better now');
		subs?.close();
	}

	function remove(injury: InjuryDraft) {
		const title = named(injury);
		value.injuries.splice(
			value.injuries.findIndex((i) => i.key === injury.key),
			1
		);
		// Its errors go with it: a row added later under the same key starts without them.
		delete pinned[injury.key];
		announce(`Removed ${title}`);
		subs?.close();
	}

	// The screen's title follows its injury once it has an area ("Left knee").
	$effect(() => {
		const top = subs?.top;
		if (!top || !open?.bodyArea) return;
		const title = injuryTitle(open);
		if (top.title !== title) top.title = title;
	});

	// A save gives a new injury its stored id, so after one its screen has nothing to show: the
	// remounted editor goes back to the list.
	$effect(() => {
		if (subs?.top?.id.startsWith(SCREEN) && !open) subs.reset();
	});

	// The row that opened a screen is gone while the screen shows: on the way back, focus goes to
	// the injury's row (in whichever list it is now), or to Add an injury once it was removed.
	let shown: string | undefined;
	$effect(() => {
		const key = open?.key;
		if (key) {
			shown = key;
			return;
		}
		const back = shown;
		shown = undefined;
		if (back) void tick().then(() => focusRow(back));
	});

	function focusRow(key: string) {
		const index = [...active, ...resolved].findIndex((i) => i.key === key);
		const row = root?.querySelectorAll<HTMLElement>('[data-testid="injury"]')[index];
		(row ?? root?.querySelector<HTMLElement>('[data-testid="add-injury"]'))?.focus();
	}

	/**
	 * What to leave out, as typed: the list keeps only whole movements, so the field shows the
	 * words themselves while they are typed (a space or a comma would otherwise vanish).
	 */
	let typed = $state<{ key: string; text: string } | null>(null);
</script>

{#if open}
	{#each [open] as injury (injury.key)}
		{@const own = rowErrors[injury.key] ?? {}}
		<div class="injury">
			<div class="rows">
				<PickRow
					label="Where"
					options={areas}
					bind:value={injury.bodyArea}
					error={own.bodyArea}
					data-testid="injury-where"
				/>
				<PickRow
					label="Side"
					options={sides}
					bind:value={
						() => injury.side ?? NO_SIDE,
						(side) => (injury.side = !side || side === NO_SIDE ? null : side)
					}
					error={own.side}
					data-testid="injury-side"
				/>
				<PickRow
					label="How much it limits you"
					options={severities}
					bind:value={injury.severity}
					error={own.severity}
					data-testid="injury-severity"
				/>
			</div>
			<TextField
				label="What to leave out, in your words"
				placeholder="Box jumps, deep lunges"
				hint="Separate them with commas."
				bind:value={
					() => (typed?.key === injury.key ? typed.text : avoidText(injury.avoid)),
					(text) => {
						typed = { key: injury.key, text };
						injury.avoid = avoidList(text);
					}
				}
				error={own.avoid}
				maxlength={740}
				data-testid="injury-avoid"
			/>
			<TextArea
				label="Anything else about it?"
				optional
				rows={2}
				placeholder="What sets it off, what helps…"
				bind:value={() => injury.notes ?? '', (notes) => (injury.notes = notes || null)}
				error={own.notes}
				maxlength={300}
				data-testid="injury-notes"
			/>
			<div class="rows">
				<ListRow
					title={injury.active ? 'It’s better now' : 'It’s bothering me again'}
					onclick={() => toggleActive(injury)}
					data-testid="injury-better"
				/>
				<ListRow
					title="Remove this injury"
					danger
					onclick={() => remove(injury)}
					data-testid="injury-remove"
				/>
			</div>
		</div>
	{/each}
{:else}
	<div class="injuries" bind:this={root}>
		{#if active.length}
			<div class="rows">
				{#each active as injury (injury.key)}
					<ListRow
						title={named(injury)}
						value={injuryRowValue(injury)}
						onclick={() => edit(injury)}
						aria-invalid={rowErrors[injury.key] ? 'true' : undefined}
						data-testid="injury"
					/>
				{/each}
			</div>
		{:else}
			<p class="empty" data-testid="injuries-empty">Nothing to work around.</p>
		{/if}
		<!-- A text link as wide as its words (Paper), 8 px under the last row. -->
		<div class="more">
			<Button variant="link" onclick={add} data-testid="add-injury">Add an injury</Button>
		</div>
		{#if resolved.length}
			<section class="group" aria-labelledby="{id}-better">
				<h2 class="label" id="{id}-better">Better now</h2>
				{#each resolved as injury (injury.key)}
					<ListRow
						title={named(injury)}
						muted
						onclick={() => edit(injury)}
						aria-invalid={rowErrors[injury.key] ? 'true' : undefined}
						data-testid="injury"
					/>
				{/each}
			</section>
		{/if}
		{#if errors.injuries}<p class="error">{errors.injuries}</p>{/if}
	</div>
{/if}

<p class="visually-hidden" role="status">{announcement}</p>

<style>
	.injuries,
	.rows {
		display: grid;
	}

	.more {
		padding-top: var(--space-2);
	}

	/* Better now: 36 px under Add an injury, its label directly on its rows (Paper). */
	.group {
		display: grid;
		margin-top: var(--space-9);
	}

	.label {
		font: var(--type-secondary);
		color: var(--color-text-tertiary);
	}

	/* An injury's screen: its three questions, the two fields, then what to do with it. */
	.injury {
		display: grid;
		gap: var(--space-5);
	}

	.empty {
		font: var(--type-body);
		color: var(--color-text-tertiary);
	}

	/* An error about the whole list: one red line under it. */
	.error {
		font: var(--type-caption);
		color: var(--color-danger);
	}
</style>
