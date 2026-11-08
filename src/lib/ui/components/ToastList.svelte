<!--
  @component
  The toasts inside Toaster's live region. Toaster loads it on demand and holds its styles.
-->
<script lang="ts">
	import { untrack } from 'svelte';
	import { toast, type ToastItem } from '../toast.svelte';
	import Icon from './Icon.svelte';

	// A dismissed toast stays, inert, until it has slid out. CSS animations, not svelte/transition:
	// its runtime would sit in the framework chunk every route loads, for this one component.
	let shown = $state<(ToastItem & { leaving?: boolean })[]>([]);
	$effect.pre(() => {
		const live = new Map(toast.items.map((item) => [item.id, item]));
		const kept = untrack(() => shown).map(
			(item) => live.get(item.id) ?? { ...item, leaving: true }
		);
		const known = new Set(kept.map((item) => item.id));
		const added = toast.items.filter((item) => !known.has(item.id));
		shown = [...kept, ...added];
		for (const item of added) toast.appeared(item.id);
	});
	const remove = (id: number) => (shown = shown.filter((item) => item.id !== id));
</script>

{#each shown as item (item.id)}
	<div
		class="toast"
		data-tone={item.tone}
		data-leaving={item.leaving}
		inert={item.leaving}
		onanimationend={() => item.leaving && remove(item.id)}
	>
		<Icon
			name={item.tone === 'danger' ? 'alert' : item.tone === 'positive' ? 'check' : 'info'}
			size={20}
		/>
		<p class="message">{item.message}</p>
		{#if item.action}
			<button
				type="button"
				class="action"
				onclick={() => {
					item.action?.onclick();
					toast.dismiss(item.id);
				}}>{item.action.label}</button
			>
		{/if}
		<button
			type="button"
			class="dismiss"
			aria-label="Dismiss notification"
			onclick={() => toast.dismiss(item.id)}
		>
			<Icon name="close" size={18} />
		</button>
	</div>
{/each}
