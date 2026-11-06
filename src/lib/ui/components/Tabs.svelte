<!--
  @component
  Accessible tabs (WAI-ARIA tablist): roving focus, arrow/Home/End keys, automatic
  activation, animated indicator. Renders only the active panel via the `panel` snippet.
-->
<script lang="ts" generics="T extends string">
	import type { Snippet } from 'svelte';

	interface Tab {
		id: T;
		label: string;
	}

	interface Props {
		tabs: Tab[];
		value: T;
		label: string;
		onchange?: (value: T) => void;
		panel: Snippet<[T]>;
	}

	let { tabs, value = $bindable(), label, onchange, panel }: Props = $props();

	const uid = $props.id();
	const index = $derived(
		Math.max(
			0,
			tabs.findIndex((t) => t.id === value)
		)
	);
	let buttons: HTMLButtonElement[] = $state([]);

	function activate(i: number, focus = false) {
		const tab = tabs[i];
		if (!tab) return;
		if (tab.id !== value) {
			value = tab.id;
			onchange?.(tab.id);
		}
		if (focus) buttons[i]?.focus();
	}

	function onkeydown(event: KeyboardEvent) {
		const last = tabs.length - 1;
		const next = (
			{
				ArrowRight: index === last ? 0 : index + 1,
				ArrowLeft: index === 0 ? last : index - 1,
				Home: 0,
				End: last
			} as Record<string, number>
		)[event.key];
		if (next !== undefined) {
			event.preventDefault();
			activate(next, true);
		}
	}
</script>

<div class="tabs">
	<div
		class="list"
		role="tablist"
		aria-label={label}
		style:--count={tabs.length}
		style:--index={index}
	>
		{#each tabs as tab, i (tab.id)}
			<button
				bind:this={buttons[i]}
				type="button"
				role="tab"
				class="tab"
				id={`${uid}-tab-${tab.id}`}
				aria-selected={tab.id === value}
				aria-controls={`${uid}-panel`}
				tabindex={tab.id === value ? 0 : -1}
				onclick={() => activate(i)}
				{onkeydown}
			>
				{tab.label}
			</button>
		{/each}
		<span class="indicator" aria-hidden="true"></span>
	</div>
	<div
		class="panel"
		role="tabpanel"
		id={`${uid}-panel`}
		aria-labelledby={`${uid}-tab-${value}`}
		tabindex="0"
	>
		{@render panel(value)}
	</div>
</div>

<style>
	.tabs {
		display: grid;
		gap: var(--space-4);
	}

	.list {
		position: relative;
		container-type: inline-size;
		display: grid;
		grid-template-columns: repeat(var(--count), minmax(0, 1fr));
		border-bottom: 1px solid var(--color-hairline);
	}

	.tab {
		min-height: var(--touch-target);
		padding: 0 var(--space-2);
		font-size: var(--text-sm);
		font-weight: var(--weight-semibold);
		color: var(--color-text-tertiary);
		transition:
			color var(--duration-base) var(--ease-standard),
			background-color var(--duration-fast) var(--ease-standard);
	}

	.tab[aria-selected='true'] {
		color: var(--color-text);
	}

	/* The pill is the moving box, centred under the active tab, stepped in tab widths of the list
	   (cqi). A tab-wide box carrying the pill overshot the list's end by 8.5% of the travel on
	   the spring, past a 393 px page, and mobile browsers keep a page widened by that. */
	.indicator {
		position: absolute;
		bottom: -1px;
		left: calc(100% / var(--count) / 2 - 16px);
		width: 32px;
		height: 2px;
		border-radius: var(--radius-full);
		background: var(--color-accent);
		transform: translateX(calc(var(--index) * 100cqi / var(--count)));
		transition: transform var(--duration-slow) var(--ease-spring);
		/* Decoration: a tap on the tab's bottom edge must reach the tab. */
		pointer-events: none;
	}

	.panel:focus-visible {
		outline-offset: 4px;
		border-radius: var(--radius-md);
	}

	@media (hover: hover) and (pointer: fine) {
		.tab[aria-selected='false']:hover {
			border-radius: var(--radius-md);
			background: var(--color-surface-2);
			color: var(--color-text-secondary);
		}
	}
</style>
