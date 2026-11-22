import { describe, expect, it } from 'vitest';
import { slideFrom } from './flip';

describe('slideFrom', () => {
	it('starts a moved block where it was: down from above, up from below', () => {
		// A taller card above pushed it 48 px down: it starts 48 px up and slides down.
		expect(slideFrom(400, 448)).toBe(-48);
		// A shorter card: it starts 30 px lower and slides up.
		expect(slideFrom(400, 370)).toBe(30);
	});

	it('leaves a block that did not move, or moved by layout rounding, alone', () => {
		expect(slideFrom(400, 400)).toBe(0);
		expect(slideFrom(400, 400.6)).toBe(0);
		expect(slideFrom(400, 399.2)).toBe(0);
	});

	it('only raises a block stuck to the foot, so its foot never leaves a gap', () => {
		// The logger grew: its top rose 60 px; it rises from where it was.
		expect(slideFrom(600, 540, true)).toBe(60);
		// It shrank: shown higher than it is, it would float above the edge, so it moves at once.
		expect(slideFrom(540, 600, true)).toBe(0);
	});
});
