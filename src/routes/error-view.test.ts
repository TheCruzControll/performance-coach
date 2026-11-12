/**
 * The designed failure states as the server renders them (svelte/server), which is what paints
 * first; e2e/screens.desktop.e2e.ts and e2e/offline.e2e.ts cover the browser.
 * - Typographic apostrophes: 'You’re offline', never "You're offline".
 * - In the app shell the state lines up with the page title above it (start); alone, with no
 *   title above it, it is centred in the window.
 */
import { render } from 'svelte/server';
import { describe, expect, it, vi } from 'vitest';
import ErrorView from './ErrorView.svelte';

vi.mock('$app/state', () => ({ page: { url: new URL('http://app/today/unknown') } }));
vi.mock('$app/navigation', () => ({
	afterNavigate: vi.fn(),
	beforeNavigate: vi.fn(),
	onNavigate: vi.fn()
}));
vi.mock('$app/paths', () => ({ resolve: (path: string) => path.replace('/(app)', '') }));

const html = (props: Parameters<typeof render<typeof ErrorView>>[1]['props']) =>
	render(ErrorView, { props }).body;

describe('ErrorView', () => {
	it('writes the offline state with typographic apostrophes', () => {
		const body = html({ kind: 'offline', inShell: true, screen: 'Today' });
		expect(body).toContain('You’re offline');
		expect(body).toContain('as soon as you’re back online');
		expect(body).not.toMatch(/[A-Za-z]'[a-z]/);
	});

	it('lines the not-found state up with the page title in the shell', () => {
		const body = html({ kind: 'not-found', status: 404, inShell: true });
		expect(body).toMatch(/<h1[^>]*>[\s\S]*Not found/);
		expect(body).toMatch(/<div class="empty[^"]*\bstart\b[^"]*"/);
	});

	it('centres every state outside the shell, where no title sits above it', () => {
		for (const kind of ['offline', 'not-found', 'error'] as const) {
			const body = html({ kind, status: kind === 'not-found' ? 404 : 500 });
			expect(body, kind).toMatch(/<div class="empty[^"]*"/);
			expect(body, kind).not.toMatch(/<div class="empty[^"]*\bstart\b/);
		}
	});

	it('lines every state up with the title in the shell', () => {
		for (const kind of ['offline', 'not-found', 'error'] as const) {
			const body = html({ kind, status: 500, inShell: true, screen: 'Today' });
			expect(body, kind).toMatch(/<div class="empty[^"]*\bstart\b/);
		}
	});
});
