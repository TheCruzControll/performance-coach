import { describe, expect, it } from 'vitest';
import { feedbackSupport } from '#lib/client/workout/feedback.ts';
import { toggleRows } from './settings-rows';

const keys = (support: Parameters<typeof toggleRows>[0]) => toggleRows(support).map((r) => r.key);

describe('the settings sheet’s on/off rows', () => {
	it('shows all four where the browser has every feedback (Chromium on Android)', () => {
		expect(keys({ vibration: true, tone: true, wakeLock: true })).toEqual([
			'autoStartRest',
			'sound',
			'vibration',
			'keepAwake'
		]);
	});

	it('hides vibration on iOS Safari, which has no Vibration API', () => {
		const safari = feedbackSupport({
			navigator: { wakeLock: { request: () => Promise.reject(new Error('unused')) } },
			AudioContext: class {} as unknown as typeof AudioContext
		});
		expect(keys(safari)).toEqual(['autoStartRest', 'sound', 'keepAwake']);
	});

	it('offers vibration on an iPhone, whose haptic tap on Complete set it turns off', () => {
		const iPhone = feedbackSupport({
			navigator: { maxTouchPoints: 5 },
			AudioContext: class {} as unknown as typeof AudioContext,
			HTMLInputElement: { prototype: { switch: false } }
		});
		expect(keys(iPhone)).toEqual(['autoStartRest', 'sound', 'vibration']);
		const vibration = toggleRows(iPhone).find((row) => row.key === 'vibration');
		expect(vibration?.description).toMatch(/iPhone/);
	});

	it('hides each feedback the browser lacks, and always offers starting rest by itself', () => {
		expect(keys({ vibration: false, tone: false, wakeLock: false })).toEqual(['autoStartRest']);
		expect(keys({ vibration: true, tone: false, wakeLock: false })).toEqual([
			'autoStartRest',
			'vibration'
		]);
		expect(keys({ vibration: false, tone: true, wakeLock: false })).toEqual([
			'autoStartRest',
			'sound'
		]);
		expect(keys({ vibration: false, tone: false, wakeLock: true })).toEqual([
			'autoStartRest',
			'keepAwake'
		]);
	});

	it('words every row', () => {
		for (const row of toggleRows({ vibration: true, tone: true, wakeLock: true })) {
			expect(row.label.length, row.key).toBeGreaterThan(0);
			expect(row.description.length, row.key).toBeGreaterThan(0);
			expect(Object.keys(row)).toEqual(['key', 'label', 'description']);
		}
	});
});
