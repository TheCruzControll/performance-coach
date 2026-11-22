/**
 * serialiseRoad (road-view.ts): the coach's road in at most ROAD_TEXT_MAX_BYTES, where today is,
 * the events and the deloads and tapers first, then the blocks in order, the furthest left out
 * with a line saying how many and how far. getRoadView itself is covered on real Postgres
 * (tests/integration/periodisation/road-view.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { addDays } from '../../../domain/calendar';
import {
	DERIVED_MODES_NOTE,
	ROAD_TEXT_MAX_BYTES,
	serialiseRoad,
	type RoadBlock,
	type RoadView
} from './road-view';

const bytes = (text: string) => new TextEncoder().encode(text).length;

const block = (i: number, title = 'Marathon'): RoadBlock => ({
	lineage: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
	phase: 'marathon_build',
	label: `Block ${i + 1}`,
	startsOn: addDays('2026-11-09', 28 * i),
	endsOn: addDays('2026-11-09', 28 * i + 27),
	outline: i > 0,
	weeks: i
		? []
		: [0, 1, 2, 3].map((w) => ({
				startsOn: addDays('2026-11-09', 7 * w),
				kind: w === 3 ? 'deload' : 'build',
				current: w === 1
			})),
	goals: [
		{ ref: 'g1', title, discipline: 'distance_running', mode: 'primary' },
		{ ref: 'g2', title: 'Stay strong', discipline: 'strength', mode: 'secondary' },
		{ ref: 'g3', title: 'Muay Thai', discipline: 'muay_thai', mode: 'maintenance' }
	],
	modesNote: i > 0 ? DERIVED_MODES_NOTE : null
});

const view = (blocks: RoadBlock[]): RoadView => ({
	blocks,
	events: [{ goalTitle: 'Marathon', date: '2027-03-28', weeksAway: 19 }],
	markers: [{ week: '2026-11-30', kind: 'deload', label: 'Deload week' }],
	current: { block: 0, week: 1 }
});

describe('serialiseRoad', () => {
	it('says where today is, the events, the deloads and tapers, then each block and its modes', () => {
		expect(serialiseRoad(view([block(0), block(1)])).split('\n')).toEqual([
			'Now: Block 1, week 2 of 4.',
			'Events: Marathon 2027-03-28 (19 wk).',
			'Deloads and tapers: Deload week 2026-11-30.',
			'Block 1 2026-11-09–2026-12-06 (4 wk): primary: Marathon; secondary: Stay strong; maintenance: Muay Thai.',
			`Block 2 2026-12-07–2027-01-03 (4 wk, outline, ${DERIVED_MODES_NOTE}): primary: Marathon; secondary: Stay strong; maintenance: Muay Thai.`
		]);
	});

	it('leaves the furthest blocks out past 1.5 KB, saying how many and how far', () => {
		const long = 'A goal with a long title that the owner typed in full'.padEnd(60, '.');
		const blocks = Array.from({ length: 10 }, (_, i) => block(i, long));
		const text = serialiseRoad(view(blocks));
		expect(bytes(text)).toBeLessThanOrEqual(ROAD_TEXT_MAX_BYTES);
		const lines = text.split('\n');
		const shown = lines.filter((l) => l.startsWith('Block ')).length;
		expect(shown).toBeGreaterThan(2);
		expect(shown).toBeLessThan(10);
		expect(lines.at(-1)).toBe(`…and ${10 - shown} more to ${blocks.at(-1)!.endsOn}.`);
		// Every block that fits is shown, in order.
		expect(lines.slice(3, 3 + shown).map((l) => l.split(' ')[1])).toEqual(
			Array.from({ length: shown }, (_, i) => String(i + 1))
		);
	});

	it('with no block holding today and no events, says so', () => {
		const text = serialiseRoad({ blocks: [], events: [], markers: [], current: null });
		expect(text).toBe('Now: no block holds today.\nEvents: none ahead.');
	});
});
