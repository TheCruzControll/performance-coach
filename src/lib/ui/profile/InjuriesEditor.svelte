<!--
  @component
  Profile → Injuries: anything to work around, each with its area, side, how much it limits
  training, the movements to stay away from and notes. One that is resolved stays on the list
  (the coach keeps the history) with the switch off. No injuries is a perfectly good answer.
  Cards are keyed by row, so removing one never hands its state to the next.
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
	import Badge from '../components/Badge.svelte';
	import Button from '../components/Button.svelte';
	import Card from '../components/Card.svelte';
	import ChoiceGroup from '../components/ChoiceGroup.svelte';
	import EmptyState from '../components/EmptyState.svelte';
	import IconButton from '../components/IconButton.svelte';
	import Notice from '../components/Notice.svelte';
	import TagInput from '../components/TagInput.svelte';
	import TextArea from '../components/TextArea.svelte';
	import Toggle from '../components/Toggle.svelte';
	import type { EditorProps } from './editors';
	import { errorsByRow, injuryTitle, newInjury, type InjuriesDraft } from './injuries';

	let { value = $bindable(), errors = {} }: EditorProps<InjuriesDraft> = $props();

	const areas = BODY_AREAS.map((a) => ({ value: a, label: BODY_AREA_LABEL[a] }));
	// Side is optional: "Doesn’t apply" is the choice that stands for none (radios can't clear).
	const NO_SIDE = 'none';
	const sides: { value: Side | typeof NO_SIDE; label: string }[] = [
		{ value: 'left', label: 'Left' },
		{ value: 'right', label: 'Right' },
		{ value: 'both', label: 'Both' },
		{ value: NO_SIDE, label: 'Doesn’t apply' }
	];
	const severities = SEVERITIES.map((s) => ({ value: s, label: SEVERITY_INFO[s].label }));

	/**
	 * A save's errors, pinned to the cards that were there when they came back (and only then,
	 * not again as cards come and go), so a card removed afterwards takes its errors with it
	 * instead of handing them to the card that moves up.
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

	const cards = () => [...(root?.querySelectorAll<HTMLElement>('.injury') ?? [])];

	async function add() {
		value.injuries.push(newInjury(value.injuries));
		announce('Added an injury or limitation');
		await tick();
		// Straight to what the new card needs first: where it is.
		const field = cards().at(-1)?.querySelector('input');
		field?.focus({ preventScroll: true });
		field?.scrollIntoView({ block: 'center' });
	}

	async function remove(index: number) {
		const injury = value.injuries[index]!;
		const focused = cards()[index]?.contains(document.activeElement);
		value.injuries.splice(index, 1);
		// Its errors go with it: a card added later under the same key starts without them.
		delete pinned[injury.key];
		announce(`Removed ${injuryTitle(injury)}`);
		if (!focused) return;
		// Keep keyboard focus in the list: the next card's Remove, else the one before, else Add.
		await tick();
		const next = cards()[index] ?? cards()[index - 1];
		(next?.querySelector('button') ?? root?.querySelector<HTMLElement>('.add button'))?.focus();
	}
</script>

<div class="injuries" bind:this={root}>
	{#each value.injuries as injury, i (injury.key)}
		{@const title = injuryTitle(injury)}
		{@const own = rowErrors[injury.key] ?? {}}
		<div class="injury">
			<Card {title} data-testid="injury">
				{#snippet action()}
					<IconButton icon="trash" size="sm" label="Remove {title}" onclick={() => remove(i)} />
				{/snippet}
				<div class="fields">
					{#if !injury.active}
						<Badge tone="positive" icon="check" data-testid="injury-resolved">Resolved</Badge>
					{/if}
					<ChoiceGroup
						legend="Where?"
						bind:value={injury.bodyArea}
						error={own.bodyArea}
						options={areas}
					/>
					<ChoiceGroup
						legend="Side"
						bind:value={
							() => injury.side ?? NO_SIDE,
							(side) => (injury.side = side === NO_SIDE ? null : (side as Side))
						}
						error={own.side}
						options={sides}
					/>
					<ChoiceGroup
						legend="How much does it limit you?"
						hint={injury.severity ? SEVERITY_INFO[injury.severity].hint : 'Pick the closest fit.'}
						bind:value={injury.severity}
						error={own.severity}
						options={severities}
					/>
					<TagInput
						label="Movements to avoid"
						bind:value={injury.avoid}
						hint="Anything the coach should leave out, in your words."
						placeholder="e.g. Box jumps"
						error={own.avoid}
						maxlength={60}
						max={12}
					/>
					<TextArea
						label="Notes"
						bind:value={() => injury.notes ?? '', (notes) => (injury.notes = notes || null)}
						error={own.notes}
						optional
						rows={2}
						placeholder="What sets it off, what helps…"
						maxlength={300}
					/>
					<Toggle
						label="Still affecting training"
						description={injury.active
							? 'The coach programs around it.'
							: 'Resolved: kept in your history, no longer programmed around.'}
						bind:checked={injury.active}
					/>
				</div>
			</Card>
		</div>
	{:else}
		<EmptyState
			icon="shield"
			tone="neutral"
			title="Nothing to work around"
			description="If something hurts or a movement is off-limits, add it here and the coach programs around it."
			data-testid="injuries-empty"
		/>
	{/each}

	{#if errors.injuries}<Notice tone="danger">{errors.injuries}</Notice>{/if}

	<div class="add">
		<Button variant="secondary" icon="plus" block onclick={add}>
			{value.injuries.length ? 'Add another' : 'Add an injury or limitation'}
		</Button>
	</div>

	<p class="visually-hidden" role="status">{announcement}</p>
</div>

<style>
	.injuries {
		display: grid;
		gap: var(--space-4);
	}

	.fields {
		display: grid;
		gap: var(--space-5);
	}
</style>
