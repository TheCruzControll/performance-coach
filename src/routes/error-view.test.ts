/**
 * The designed failure states as the server renders them (svelte/server), which is what paints
 * first; e2e/screens.desktop.e2e.ts and e2e/offline.e2e.ts cover the browser.
 * - Typographic apostrophes: 'doesn’t', never "doesn't".
 * - Each state says one thing (one h1) and offers at most one thing to do (Paper, 10 · States).
 * - On Today it keeps the avatar, Profile's way in on a phone.
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
	it('names the screen that needs a connection, with typographic apostrophes and no button', () => {
		const body = html({ kind: 'offline', inShell: true, screen: 'Progress' });
		expect(body).toMatch(/<h1[^>]*>Progress needs a connection<\/h1>/);
		expect(body).toContain('when you’re back online');
		expect(body).not.toMatch(/[A-Za-z]'[a-z]/);
		expect(body).not.toContain('<button');
		expect(body).toContain('data-testid="offline-state"');
	});

	it('says one thing and offers one thing in every state', () => {
		for (const kind of ['offline', 'not-found', 'error'] as const) {
			for (const inShell of [true, false]) {
				const body = html({ kind, inShell, screen: 'Train' });
				expect(body.match(/<h1\b/g), `${kind} ${inShell}`).toHaveLength(1);
				const actions = (body.match(/<(button|a)\b[^>]*class="[^"]*\bbtn\b/g) ?? []).length;
				expect(actions, `${kind} ${inShell}`).toBeLessThanOrEqual(1);
			}
		}
	});

	it('an error is one red line, the sentence, Try again and the reference', () => {
		const body = html({ kind: 'error', requestId: '121e46cd', inShell: true });
		expect(body).toMatch(/<p class="line[^"]*">Something went wrong<\/p>/);
		expect(body).toMatch(/<h1[^>]*>That one is on us\. Your training is safe<\/h1>/);
		expect(body).toContain('Try again');
		expect(body).toContain('121e46cd');
	});

	it('a missing page offers the way home', () => {
		const body = html({ kind: 'not-found', inShell: true });
		expect(body).toMatch(/<h1[^>]*>Nothing here<\/h1>/);
		expect(body).toContain('This page doesn’t exist. Your training is safe.');
		expect(body).toMatch(/<a[^>]*href="\/today"[^>]*>[\s\S]*Back to Today/);
	});

	it('keeps the avatar on Today, and only there', () => {
		expect(html({ kind: 'error', inShell: true, screen: 'Today' })).toContain(
			'data-testid="today-avatar"'
		);
		expect(html({ kind: 'error', inShell: true, screen: 'Train' })).not.toContain('today-avatar');
		expect(html({ kind: 'error', screen: 'Today' })).not.toContain('today-avatar');
	});
});
