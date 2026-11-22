<script lang="ts" module>
	import { browser } from '$app/env';
	import { errorPage, provideErrorPage } from './error-page.ts';

	// SvelteKit loads this component before it hydrates any page, so it stays light: the page
	// itself loads on demand (src/routes/error-page.ts).
	provideErrorPage(() => import('./ErrorPage.svelte'));
	// The server renders it whole, and an error page it rendered hydrates with it: SvelteKit
	// awaits this module. A failed load in the browser is left to the {:catch} below.
	if (!browser) await errorPage.load();
	else if (document.querySelector('[data-root-error]')) await errorPage.load().catch(() => {});
</script>

<script lang="ts">
	import { page } from '$app/state';

	const content = errorPage.current();
	const RETRY_STYLE =
		'display: inline-flex; align-items: center; justify-content: center; min-height: 44px; color: var(--color-accent); font-weight: var(--weight-semibold)';
</script>

{#await content then ErrorPage}
	<ErrorPage />
{:catch}
	<!-- Its code could not be fetched (offline before it loaded): plain words and a way back.
	     Inline styles: a <style> block would add a stylesheet to every route's start-up. -->
	<main
		id="main"
		style="display: grid; place-content: center; gap: var(--space-3); min-height: 100dvh; padding: var(--space-6); text-align: center"
	>
		<h1>{page.error?.offline ? 'You’re offline' : 'Something went wrong'}</h1>
		<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- this screen's own URL -->
		<a href={page.url.pathname + page.url.search} style={RETRY_STYLE}>Try again</a>
	</main>
{/await}
