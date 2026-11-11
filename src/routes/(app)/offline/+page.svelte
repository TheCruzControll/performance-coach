<script lang="ts">
	import { page } from '$app/state';
	import ErrorView from '../../ErrorView.svelte';
	import { screenName } from '../nav';
	import LaunchRedirect from './LaunchRedirect.svelte';
</script>

<!-- A launch mid-workout opens the workout instead, before the app boots (launch.ts). -->
<LaunchRedirect />

<!-- Served by the service worker at the URL that failed (e.g. /profile): keep its name. -->
<ErrorView kind="offline" screen={screenName(page.url.pathname)} inShell />
