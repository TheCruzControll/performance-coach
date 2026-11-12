/**
 * StatusSlot.svelte's decision, kept apart so it runs in unit tests: the screen's Status Display
 * on a page showing Graphite 2004 (the pre-paint script in src/app.html sets `data-design` on
 * <html>), and on today's design nothing, without fetching a byte of it.
 */
export async function chosenDisplay<T>(
	root: Pick<HTMLElement, 'dataset'>,
	load: () => Promise<{ default: T }>
): Promise<T | null> {
	if (root.dataset.design !== 'graphite') return null;
	try {
		return (await load()).default;
	} catch {
		return null;
	}
}
