import { afterEach, describe, expect, it, vi } from 'vitest';
import { calculatePlates, STANDARD_BARS, STANDARD_PLATES } from '#lib/domain/plates.ts';
import {
	defaultPlateInventory,
	PLATE_LIMITS,
	PLATES_KEY,
	readPlateInventory,
	writePlateInventory
} from './plates';

/** A localStorage over a Map; a second reader over the same entries is the page after a reload. */
function memoryStorage(initial: Record<string, string> = {}) {
	const entries = new Map(Object.entries(initial));
	return {
		entries,
		getItem: (key: string) => entries.get(key) ?? null,
		setItem: (key: string, value: string) => void entries.set(key, value)
	};
}

const holding = (value: unknown) => memoryStorage({ [PLATES_KEY]: JSON.stringify(value) });

const KG = {
	bar: 20,
	plates: [25, 20, 15, 10, 5, 2.5, 1.25, 0.5, 0.25].map((weight) => ({ weight }))
};
const LB = { bar: 45, plates: [45, 35, 25, 10, 5, 2.5, 1.25].map((weight) => ({ weight })) };

afterEach(() => {
	vi.unstubAllGlobals();
	Reflect.deleteProperty(globalThis, 'localStorage');
});

describe('plate inventory: defaults', () => {
	it("is M1's Olympic bar and standard plates per unit, with no pair limit", () => {
		expect(readPlateInventory('kg', memoryStorage())).toEqual(KG);
		expect(readPlateInventory('lb', memoryStorage())).toEqual(LB);
		for (const unit of ['kg', 'lb'] as const) {
			expect(defaultPlateInventory(unit)).toEqual({
				bar: STANDARD_BARS[unit][0]!.weight,
				plates: STANDARD_PLATES[unit].map((weight) => ({ weight }))
			});
		}
	});

	it("answers as M1's calculator does today, so Train's tool is unchanged", () => {
		const { bar, plates } = readPlateInventory('kg', memoryStorage());
		expect(calculatePlates(142.5, bar, plates)).toEqual(
			calculatePlates(142.5, 20, STANDARD_PLATES.kg)
		);
		const lb = readPlateInventory('lb', memoryStorage());
		expect(calculatePlates(315, lb.bar, lb.plates).perSide).toEqual([45, 45, 45]);
	});

	it('is kept under pc:plates:v1', () => {
		expect(PLATES_KEY).toBe('pc:plates:v1');
		const storage = memoryStorage();
		writePlateInventory('kg', { bar: 15 }, storage);
		expect([...storage.entries.keys()]).toEqual(['pc:plates:v1']);
	});

	it('hands out copies, so a screen that changes one never changes the defaults', () => {
		const inventory = readPlateInventory('kg', memoryStorage());
		inventory.bar = 0;
		inventory.plates[0]!.pairs = 1;
		inventory.plates.pop();
		defaultPlateInventory('lb').plates.length = 0;
		expect(readPlateInventory('kg', memoryStorage())).toEqual(KG);
		expect(defaultPlateInventory('lb')).toEqual(LB);
	});
});

describe('plate inventory: one per unit', () => {
	it('keeps each unit apart, across a reload', () => {
		const storage = memoryStorage();
		writePlateInventory('kg', { bar: 15 }, storage);
		expect(readPlateInventory('lb', storage)).toEqual(LB);
		writePlateInventory('lb', { plates: [{ weight: 45, pairs: 4 }, { weight: 25 }] }, storage);
		const reloaded = memoryStorage(Object.fromEntries(storage.entries));
		expect(readPlateInventory('kg', reloaded)).toEqual({ ...KG, bar: 15 });
		expect(readPlateInventory('lb', reloaded)).toEqual({
			bar: 45,
			plates: [{ weight: 45, pairs: 4 }, { weight: 25 }]
		});
	});

	it('changes only what a write names, over what the unit already holds', () => {
		const storage = memoryStorage();
		writePlateInventory('kg', { plates: [{ weight: 20, pairs: 6 }, { weight: 10 }] }, storage);
		const { inventory, saved } = writePlateInventory('kg', { bar: 0 }, storage);
		expect(saved).toBe(true);
		expect(inventory).toEqual({ bar: 0, plates: [{ weight: 20, pairs: 6 }, { weight: 10 }] });
		expect(readPlateInventory('kg', storage)).toEqual(inventory);
	});

	it("loads only what this gym has: the exact solver keeps to the inventory's pairs", () => {
		const storage = memoryStorage();
		const plates = [{ weight: 25, pairs: 1 }, { weight: 20 }, { weight: 10 }];
		const { inventory } = writePlateInventory('kg', { plates }, storage);
		expect(calculatePlates(120, inventory.bar, inventory.plates).perSide).toEqual([20, 20, 10]);
		expect(calculatePlates(120, 20, [25, 20, 10]).perSide).toEqual([25, 25]);
	});

	it('stores only the units it knows', () => {
		const storage = holding({ kg: { bar: 15 }, stones: { bar: 3 } });
		writePlateInventory('lb', { bar: 35 }, storage);
		expect(JSON.parse(storage.entries.get(PLATES_KEY)!)).toEqual({
			kg: { bar: 15 },
			lb: { ...LB, bar: 35 }
		});
	});
});

describe('plate inventory: corrupt or partial storage', () => {
	it('falls back to the defaults when the stored value is not JSON or not an object', () => {
		for (const raw of ['{not json', '[]', '"plates"', '42', 'null', '']) {
			const storage = memoryStorage({ [PLATES_KEY]: raw });
			expect(readPlateInventory('kg', storage), raw).toEqual(KG);
			expect(readPlateInventory('lb', storage), raw).toEqual(LB);
		}
	});

	it("defaults one unit's corrupt inventory and keeps the other's", () => {
		const storage = holding({ kg: 'olympic', lb: { bar: 35 } });
		expect(readPlateInventory('kg', storage)).toEqual(KG);
		expect(readPlateInventory('lb', storage)).toEqual({ ...LB, bar: 35 });
	});

	it('falls back field by field: the bar and the plates on their own', () => {
		expect(
			readPlateInventory('kg', holding({ kg: { bar: 'heavy', plates: [{ weight: 20 }] } }))
		).toEqual({ bar: 20, plates: [{ weight: 20 }] });
		expect(readPlateInventory('kg', holding({ kg: { bar: 15, plates: 'all' } }))).toEqual({
			...KG,
			bar: 15
		});
	});

	it('drops the plates it cannot use, keeps the rest heaviest first, and the first of a weight', () => {
		const plates = [
			{ weight: 5 },
			{ weight: 0 },
			{ weight: -10 },
			{ weight: '20' },
			{ weight: 2.0005 },
			null,
			10,
			{ weight: 20, pairs: 2 },
			{ weight: 20, pairs: 9 },
			{ weight: 1.25 }
		];
		expect(readPlateInventory('kg', holding({ kg: { plates } }))).toEqual({
			bar: 20,
			plates: [{ weight: 20, pairs: 2 }, { weight: 5 }, { weight: 1.25 }]
		});
	});

	it('reads a pair count it cannot use as no limit, keeping the plate', () => {
		const plates = [0, -1, 1.5, 21, '3', null].map((pairs) => ({ weight: 10, pairs }));
		for (const plate of plates) {
			const read = readPlateInventory('kg', holding({ kg: { plates: [plate] } }));
			expect(read.plates, JSON.stringify(plate)).toEqual([{ weight: 10 }]);
		}
	});

	it('defaults plates of which none is usable, while an empty list is a bar with no plates', () => {
		const junk = holding({ kg: { plates: [{ weight: 0 }, 'x'] } });
		expect(readPlateInventory('kg', junk)).toEqual(KG);
		const none = readPlateInventory('kg', holding({ kg: { bar: 20, plates: [] } }));
		expect(none).toEqual({ bar: 20, plates: [] });
		expect(calculatePlates(60, none.bar, none.plates)).toMatchObject({ perSide: [], achieved: 20 });
	});

	it('keeps the current value, not the default, for a field a write gets wrong', () => {
		const storage = memoryStorage();
		writePlateInventory('kg', { bar: 15, plates: [{ weight: 10 }] }, storage);
		const { inventory } = writePlateInventory(
			'kg',
			{ bar: -1, plates: [{ weight: Number.NaN }] },
			storage
		);
		expect(inventory).toEqual({ bar: 15, plates: [{ weight: 10 }] });
	});
});

describe('plate inventory: bounds', () => {
	it('allows a bar from none (a plate-loaded machine) to 100 kg or 220 lb', () => {
		expect(PLATE_LIMITS.bar).toEqual({ kg: 100, lb: 220 });
		for (const [unit, bar] of [
			['kg', 0],
			['kg', 100],
			['kg', 12.5],
			['lb', 220]
		] as const) {
			expect(readPlateInventory(unit, holding({ [unit]: { bar } })).bar).toBe(bar);
		}
		for (const [unit, bar] of [
			['kg', 100.5],
			['kg', -2.5],
			['lb', 221],
			['kg', 20.0001]
		] as const) {
			expect(readPlateInventory(unit, holding({ [unit]: { bar } })).bar).toBe(
				unit === 'kg' ? 20 : 45
			);
		}
	});

	it('allows plates up to 50 kg or 100 lb, in thousandths, and 1 to 20 pairs of each', () => {
		expect(PLATE_LIMITS.plate).toEqual({ kg: 50, lb: 100 });
		expect(PLATE_LIMITS.pairs).toBe(20);
		const kg = [
			{ weight: 50 },
			{ weight: 50.5 },
			{ weight: 0.125, pairs: 20 },
			{ weight: 1, pairs: 1 }
		];
		expect(readPlateInventory('kg', holding({ kg: { plates: kg } })).plates).toEqual([
			{ weight: 50 },
			{ weight: 1, pairs: 1 },
			{ weight: 0.125, pairs: 20 }
		]);
		const lb = [{ weight: 100 }, { weight: 101 }];
		expect(readPlateInventory('lb', holding({ lb: { plates: lb } })).plates).toEqual([
			{ weight: 100 }
		]);
	});

	it('keeps at most 20 plate weights, the heaviest', () => {
		const plates = Array.from({ length: 25 }, (_, i) => ({ weight: i + 1 }));
		const read = readPlateInventory('kg', holding({ kg: { plates } })).plates;
		expect(PLATE_LIMITS.kinds).toBe(20);
		expect(read.map((p) => p.weight)).toEqual(Array.from({ length: 20 }, (_, i) => 25 - i));
	});
});

describe('plate inventory: storage that fails never breaks a screen', () => {
	const insecure = () => {
		throw new DOMException('The operation is insecure.', 'SecurityError');
	};

	it('reads the defaults when reading throws, and saved: false when writing does', () => {
		expect(readPlateInventory('kg', { getItem: insecure, setItem: insecure })).toEqual(KG);
		const storage = { ...memoryStorage(), setItem: insecure };
		expect(writePlateInventory('lb', { bar: 35 }, storage)).toEqual({
			inventory: { ...LB, bar: 35 },
			saved: false
		});
		expect(readPlateInventory('lb', storage)).toEqual(LB);
	});

	it('works with no storage at all', () => {
		expect(readPlateInventory('kg', null)).toEqual(KG);
		expect(writePlateInventory('kg', { bar: 15 }, null)).toEqual({
			inventory: { ...KG, bar: 15 },
			saved: false
		});
	});

	it("uses the page's localStorage by default, and the defaults where touching it throws", () => {
		const storage = memoryStorage();
		vi.stubGlobal('localStorage', storage);
		expect(writePlateInventory('kg', { bar: 15 }).saved).toBe(true);
		expect(readPlateInventory('kg')).toEqual({ ...KG, bar: 15 });
		vi.unstubAllGlobals();
		expect(readPlateInventory('kg')).toEqual(KG);
		Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: insecure });
		expect(readPlateInventory('kg')).toEqual(KG);
		expect(writePlateInventory('kg', { bar: 15 }).saved).toBe(false);
	});
});
