<!--
  @component
  The root error page's content (src/routes/+error.svelte loads it on demand: src/routes/error-page.ts).
-->
<script lang="ts">
	import { page } from '$app/state';
	import AppShell from './(app)/AppShell.svelte';
	import { isAppPath, screenName } from './(app)/nav';
	import ErrorView, { errorKind } from './ErrorView.svelte';

	// Errors that escape the (app) error boundary land here, e.g. a screen whose data could not
	// be fetched during client-side navigation (offline). App URLs keep the shell and the nav.
	const inShell = $derived(isAppPath(page.url.pathname));
	const kind = $derived(errorKind(page.status, page.error));
</script>

<!-- How +error.svelte knows the server rendered this page (the (app) boundary renders ErrorView too). -->
<span hidden data-root-error></span>
{#if inShell}
	<AppShell pathname={page.url.pathname} hideOfflineNotice>
		<ErrorView
			{kind}
			status={page.status}
			message={page.error?.message}
			requestId={page.error?.requestId}
			screen={screenName(page.url.pathname)}
			inShell
		/>
	</AppShell>
{:else}
	<main id="main">
		<ErrorView
			{kind}
			status={page.status}
			message={page.error?.message}
			requestId={page.error?.requestId}
		/>
	</main>
{/if}
