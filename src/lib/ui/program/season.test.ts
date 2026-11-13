import { describe, expect, it } from 'vitest';
import { addDays, type IsoDate } from '#lib/domain/calendar.ts';
import { seasonView, type SeasonRoad } from './season';

type Block = SeasonRoad['blocks'][number];

/** A block of `count` weeks from `startsOn`; an outline lists none of its weeks. */
function block(
	phase: string,
	label: string,
	startsOn: IsoDate,
	count: number,
	over: Partial<Block> = {}
): Block {
	const outline = over.outline ?? false;
	return {
		phase,
		label,
		startsOn,
		endsOn: addDays(startsOn, 7 * count - 1),
		outline,
		weeks: outline
			? []
			: Array.from({ length: count }, (_, i) => ({
					startsOn: addDays(startsOn, 7 * i),
					kind: 'accumulation'
				})),
		goals: [],
		modesNote: null,
		...over
	};
}

const FIGHT_CAMP = block('fight_camp', 'Fight camp', '2026-11-09', 4, {
	weeks: ['accumulation', 'accumulation', 'deload', 'taper'].map((kind, i) => ({
		startsOn: addDays('2026-11-09', 7 * i),
		kind
	})),
	goals: [
		{ title: 'Muay Thai fight', mode: 'primary' },
		{ title: 'Marathon', mode: 'secondary' },
		{ title: 'Build muscle', mode: 'maintenance' }
	]
});
const RECOVERY = block('recovery', 'Recovery', '2026-12-07', 1, { outline: true });
const TAPER = block('marathon_taper', 'Marathon taper', '2026-12-14', 2, { outline: true });

const ROAD: SeasonRoad = {
	blocks: [FIGHT_CAMP, RECOVERY, TAPER],
	events: [
		{ goalTitle: 'Muay Thai fight', date: '2026-12-05' },
		// Past the road's end: planned later, so not pinned.
		{ goalTitle: 'Powerlifting meet', date: '2027-03-06' }
	],
	markers: [
		{ week: '2026-11-23', kind: 'deload' },
		{ week: '2026-12-14', kind: 'taper' }
	]
};

describe('seasonView', () => {
	it('each block over its timeline block: its tone, the goals’ roles in words, the leader first', () => {
		const season = seasonView(ROAD, '2026-11-11')!;
		expect(season.blocks.map((b) => [b.key, b.label, b.tone, b.weeks, b.outline])).toEqual([
			['2026-11-09', 'Fight camp', 'build', 4, false],
			['2026-12-07', 'Recovery', 'recovery', 1, true],
			['2026-12-14', 'Marathon taper', 'taper', 2, true]
		]);
		expect(season.blocks[0]!.lanes).toEqual([
			{ goal: 'Muay Thai fight', role: 'leads', lead: true },
			{ goal: 'Marathon', role: 'secondary' },
			{ goal: 'Build muscle', role: 'maintenance' }
		]);
		expect(season.note).toBeNull();
	});

	it('ticks a planned block’s deload and taper weeks, an outline’s taper marker and its recovery', () => {
		const season = seasonView(ROAD, '2026-11-11')!;
		expect(season.blocks.map((b) => b.ticks)).toEqual([
			{ 2: 'Deload', 3: 'Taper' },
			{ 0: 'Recovery' },
			{ 0: 'Taper' }
		]);
		// Along the 7-week track: the fight on its day, each tick mid-week, today on Wednesday.
		expect(season.legend).toBe('◆ Muay Thai fight · Sat 5 Dec');
		expect(season.marks).toEqual([
			{ at: 54.1, kind: 'pin' },
			{ at: 35.7, kind: 'tick' },
			{ at: 50, kind: 'tick' },
			{ at: 64.3, kind: 'tick' },
			{ at: 78.6, kind: 'tick' },
			{ at: 5.1, kind: 'now' }
		]);
	});

	it('no events: no pins; before the road starts, no today', () => {
		const season = seasonView({ ...ROAD, events: [] }, '2026-11-01')!;
		expect(season.legend).toBe('');
		expect(season.marks.map((m) => m.kind)).toEqual(['tick', 'tick', 'tick', 'tick']);
	});

	it('a maintenance block holds every goal; a program built before M7 says its roles were worked out', () => {
		const note = 'worked out from your goals';
		const held = block('maintenance', 'Maintenance · every goal held', '2026-11-09', 6, {
			goals: [
				{ title: 'Keep strength', mode: 'maintenance' },
				{ title: 'Keep running fitness', mode: 'maintenance' }
			],
			modesNote: note
		});
		const season = seasonView({ blocks: [held], events: [], markers: [] }, '2026-11-11')!;
		expect(season.blocks[0]).toMatchObject({ tone: 'maintenance', ticks: {} });
		expect(season.blocks[0]!.lanes.map((l) => `${l.goal} · ${l.role}`)).toEqual([
			'Keep strength · maintenance',
			'Keep running fitness · maintenance'
		]);
		expect(season.blocks[0]!.lanes.some((l) => l.lead)).toBe(false);
		expect(season.note).toBe(note);
	});

	it('a road with no block is no season', () => {
		expect(seasonView({ blocks: [], events: [], markers: [] }, '2026-11-11')).toBeNull();
	});
});
