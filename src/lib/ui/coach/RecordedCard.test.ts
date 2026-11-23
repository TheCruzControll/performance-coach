/**
 * The Undo card as the server renders it, before anyone presses Undo: the label, then a real
 * button named Undo, enabled. Its states after a press (busy, Undone, Nothing to undo, a failure
 * with Try again) are the phase machine's, tested in client/coach/weigh-in-undo.test.ts.
 */
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import RecordedCard from './RecordedCard.svelte';

const html = (over: Partial<{ id: number; label: string; runId: string }> = {}) =>
	render(RecordedCard, {
		props: {
			id: 41,
			label: 'Logged 82.4 kg for today',
			runId: '00000000-0000-4000-8000-0000000000b1',
			...over
		}
	}).body;

/** The opening tag of the element with this test id. */
const tagOf = (markup: string, testId: string) =>
	markup.match(new RegExp(`<[^>]*data-testid="${testId}"[^>]*>`))?.[0] ?? '';

describe('the Undo card', () => {
	it('says what was logged, then offers Undo on a real, enabled button', () => {
		const markup = html();
		expect(markup).toContain('Logged 82.4 kg for today');
		expect(markup).toContain('Undo');
		const button = tagOf(markup, 'recorded-undo');
		expect(button.startsWith('<button')).toBe(true);
		expect(button).toContain('type="button"');
		expect(button).not.toContain('disabled');
	});

	it('is in the words of the label, and says nothing yet about an outcome', () => {
		const markup = html({ label: 'Logged 180 lb for yesterday' });
		expect(markup).toContain('Logged 180 lb for yesterday');
		expect(markup).not.toContain('Undone');
		expect(markup).not.toContain('Nothing to undo');
		expect(markup).not.toContain('recorded-failure');
	});
});
