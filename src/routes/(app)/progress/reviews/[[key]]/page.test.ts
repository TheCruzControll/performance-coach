/**
 * The reviews screen's universal load (+page.ts): the selected review's view is awaited, so the
 * server renders it and the browser hydrates it with no wait; nothing is imported without one.
 */
import { describe, expect, it } from 'vitest';
import { load } from './+page.ts';
import WeeklyReview from './WeeklyReview.svelte';

type Load = typeof load;
const run = async (data: object) =>
	(await load({ data } as unknown as Parameters<Load>[0])) as Record<string, unknown>;

describe("the reviews screen's universal load", () => {
	it('awaits the weekly view for a selected weekly review', async () => {
		const data = {
			failed: false,
			key: 'w-2026-10-26',
			rows: [],
			empty: false,
			selected: { kind: 'weekly' }
		};
		await expect(run(data)).resolves.toEqual({ ...data, View: WeeklyReview });
	});

	it('imports no view for the list alone or a failed load', async () => {
		const list = { failed: false, key: null, rows: [], empty: true, selected: null };
		await expect(run(list)).resolves.toEqual({ ...list, View: null });
		await expect(run({ failed: true, key: null })).resolves.toEqual({
			failed: true,
			key: null,
			View: null
		});
	});
});
