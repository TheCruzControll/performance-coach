import { describe, expect, it, vi } from 'vitest';
import { chosenDisplay } from './status-slot';

const root = (design?: string) =>
	({ dataset: design ? { design } : {} }) as Pick<HTMLElement, 'dataset'>;

describe('the Status Display’s switch', () => {
	it('fetches nothing on today’s design, or a design it does not know', async () => {
		const load = vi.fn(async () => ({ default: 'display' }));
		expect(await chosenDisplay(root(), load)).toBeNull();
		expect(await chosenDisplay(root('current'), load)).toBeNull();
		expect(load).not.toHaveBeenCalled();
	});

	it('loads the screen’s display on a page showing Graphite 2004', async () => {
		const load = vi.fn(async () => ({ default: 'display' }));
		expect(await chosenDisplay(root('graphite'), load)).toBe('display');
		expect(load).toHaveBeenCalledOnce();
	});

	it('shows none when its chunk is gone after a deploy', async () => {
		const load = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module'));
		expect(await chosenDisplay(root('graphite'), load)).toBeNull();
	});
});
