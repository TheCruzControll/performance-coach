<!--
  @component
  Progress → General: the whole schedule across lifting, running and Muay Thai (M6, PRD §10). Was
  the plan done, how much load did it add up to and is it rising fast, and how did recovery go.
  Server-rendered from general-data.ts.

  - A new owner and a first week are told what appears and when, never a ghost chart.
  - Under that the trends (GeneralTrends), in a chunk of their own that loads after hydration,
    served as static markup until it has (trends.ts, SectionLoader), so only this intro's code
    counts towards initial JS.
-->
<script lang="ts">
	import EmptyState from '#lib/ui/components/EmptyState.svelte';
	import type { GeneralData } from './general-data';
	import SectionLoader from './SectionLoader.svelte';
	import { generalTrends } from './trends';
	import { WIDE } from './view-layout';

	interface Props {
		general: GeneralData;
		/** The trends as the server rendered them (+page.ts, trends.ts). */
		served?: string;
	}

	let { general: g, served }: Props = $props();
</script>

<div style={WIDE} data-stage={g.stage} data-testid="general">
	{#if g.intro}
		<EmptyState
			icon={g.stage === 'first_week' ? 'sparkle' : 'progress'}
			{...g.intro}
			data-testid="general-intro"
		/>
	{/if}
	<SectionLoader section={generalTrends} props={{ general: g }} name="general" {served} />
</div>
