<script lang="ts">
	import { page } from '$app/state';
	import { errorKind } from '../error-copy.ts';
	import ErrorView from '../ErrorView.svelte';
	import { screenName } from './nav';
</script>

<ErrorView
	kind={errorKind(page.status, page.error)}
	requestId={page.error?.requestId}
	screen={screenName(page.url.pathname)}
	inShell
/>
