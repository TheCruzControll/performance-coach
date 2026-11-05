<script lang="ts">
	import { page } from '$app/state';
	import ErrorView, { errorKind } from '../ErrorView.svelte';
	import { screenName } from './nav';
</script>

<ErrorView
	kind={errorKind(page.status, page.error)}
	status={page.status}
	message={page.error?.message}
	requestId={page.error?.requestId}
	screen={screenName(page.url.pathname)}
	inShell
/>
