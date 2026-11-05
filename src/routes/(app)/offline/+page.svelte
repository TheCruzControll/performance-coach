<script lang="ts">
	import { page } from '$app/state';
	import ErrorView from '../../ErrorView.svelte';
	import { screenName } from '../nav';
</script>

<!-- Served by the service worker at the URL that failed (e.g. /profile): keep its name. -->
<ErrorView kind="offline" screen={screenName(page.url.pathname)} inShell />
