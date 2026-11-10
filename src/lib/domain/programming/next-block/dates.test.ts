import { describe, expect, it } from 'vitest';
import { addDays } from '../../calendar';
import type { IsoDate } from '../../calendar';
import { programPlanSchema } from '../../training/schemas';
import type { BlockPlan, ProgramPlan, WeekPlan } from '../../training/types';
import type { Phase } from '../../training/vocabulary';
import {
	BRIDGE_PHASE,
	BRIDGE_WEEK_KIND,
	DEFAULT_NEXT_BLOCK_START,
	MAX_NEXT_BLOCK_WEEKS,
	MIN_NEXT_BLOCK_WEEKS,
	nextBlockDates,
	offeredStarts
} from './dates';
import type { DatedBlock, NextBlockDates, NextBlockDatesInput } from './dates';

const block = (phase: Phase, startsOn: IsoDate, weeks: number, outline = true): DatedBlock => ({
	phase,
	name: phase,
	startsOn,
	endsOn: addDays(startsOn, 7 * weeks - 1),
	outline
});

/** The reviewed block: four weeks from Monday 5 Oct to Sunday 1 Nov 2026. */
const REVIEWED = block('accumulation', '2026-10-05', 4, false);
const NEXT = '2026-11-02';
/** An outline that leads to no event. */
const PLAIN = [REVIEWED, block('intensification', NEXT, 4), block('realization', '2026-11-30', 2)];
/** A marathon on Sunday 24 Jan 2027: build 6 weeks, peak 3, taper 3 ending that Sunday. */
const RACE = '2027-01-24';
const MARATHON = [
	{ ...REVIEWED, phase: 'marathon_base' as const },
	block('marathon_build', NEXT, 6),
	block('marathon_peak', '2026-12-14', 3),
	block('marathon_taper', '2027-01-04', 3)
];

const dates = (over: Partial<NextBlockDatesInput>) =>
	nextBlockDates({
		blocks: PLAIN,
		reviewedBlock: 0,
		today: NEXT,
		start: DEFAULT_NEXT_BLOCK_START,
		events: [],
		weeks: 5,
		...over
	});

const span = (b: { startsOn: IsoDate; endsOn: IsoDate }) => [b.startsOn, b.endsOn];

const TARGETS = { rpeCap: 7, volumeFactor: 1, loadStep: 0, runVolumeFactor: 1 };
const weeksFrom = (startsOn: IsoDate, n: number, kind: WeekPlan['kind']): WeekPlan[] =>
	Array.from({ length: n }, (_, i) => ({
		kind,
		startsOn: addDays(startsOn, 7 * i),
		endsOn: addDays(startsOn, 7 * i + 6),
		targets: TARGETS,
		sessions: []
	}));
const planned = (
	phase: Phase,
	b: { startsOn: IsoDate; endsOn: IsoDate; weeks: number },
	kind: WeekPlan['kind']
): BlockPlan => ({
	phase,
	name: phase,
	startsOn: b.startsOn,
	endsOn: b.endsOn,
	outline: false,
	goalRefs: [],
	progression: {},
	weeks: weeksFrom(b.startsOn, b.weeks, kind)
});

/** The whole version as a skeleton plan, which must pass checkPlan's dates and outline order. */
function skeleton(reviewed: DatedBlock, d: NextBlockDates): ProgramPlan {
	const reviewedWeeks =
		(Date.parse(reviewed.endsOn) - Date.parse(reviewed.startsOn) + 86_400_000) / 604_800_000;
	return {
		title: 'Skeleton',
		startsOn: reviewed.startsOn,
		firstPlannedDay: reviewed.startsOn,
		blocks: [
			planned(reviewed.phase, { ...reviewed, weeks: reviewedWeeks }, 'accumulation'),
			...(d.bridge ? [planned(BRIDGE_PHASE, d.bridge, BRIDGE_WEEK_KIND)] : []),
			planned(d.block.outline?.phase ?? 'accumulation', d.block, 'accumulation'),
			...d.shifted.map((b) => ({ ...b, goalRefs: [], progression: {}, weeks: [] }))
		],
		decisions: []
	};
}
const expectValid = (reviewed: DatedBlock, d: NextBlockDates) => {
	const parsed = programPlanSchema.safeParse(skeleton(reviewed, d));
	expect(parsed.error?.issues ?? []).toEqual([]);
};

describe('nextBlockDates', () => {
	it('on time: the outline’s dates, no bridge, planned from today', () => {
		const d = dates({ today: '2026-11-04' });
		expect(d.bridge).toBeUndefined();
		expect(span(d.block)).toEqual([NEXT, '2026-11-29']);
		expect(d.block.outline).toEqual(PLAIN[1]);
		expect(d.shifted).toEqual([PLAIN[2]]);
		expect(d.firstPlannedDay).toBe('2026-11-04');
		expect(d.lostWeeks).toBe(0);
		expectValid(REVIEWED, d);
	});

	it('an early review in the block’s last week: only next is offered', () => {
		const today = '2026-10-29';
		expect(offeredStarts(REVIEWED, today)).toEqual(['next_monday']);
		expect(offeredStarts(REVIEWED, NEXT)).toEqual(['this_week', 'next_monday']);
		for (const start of ['this_week', 'next_monday'] as const) {
			const d = dates({ today, start });
			expect(d.bridge).toBeUndefined();
			expect(span(d.block)).toEqual([NEXT, '2026-11-29']);
			expect(d.firstPlannedDay).toBe(NEXT);
			expectValid(REVIEWED, d);
		}
	});

	it('1 week late, this week on a Wednesday: a 1-week bridge and the outline 1 week later', () => {
		const d = dates({ today: '2026-11-11' });
		expect(d.bridge).toEqual({ startsOn: NEXT, endsOn: '2026-11-08', weeks: 1 });
		expect(span(d.block)).toEqual(['2026-11-09', '2026-12-06']);
		expect(d.shifted.map(span)).toEqual([['2026-12-07', '2026-12-20']]);
		expect(d.firstPlannedDay).toBe('2026-11-11');
		expectValid(REVIEWED, d);
	});

	it('3 weeks late: a 3-week bridge and every outline block 3 weeks later, each as long', () => {
		const d = dates({ today: '2026-11-25' });
		expect(d.bridge).toEqual({ startsOn: NEXT, endsOn: '2026-11-22', weeks: 3 });
		expect(span(d.block)).toEqual(['2026-11-23', '2026-12-20']);
		expect(d.block.weeks).toBe(4);
		expect(d.shifted.map(span)).toEqual([['2026-12-21', '2027-01-03']]);
		expect(d.lostWeeks).toBe(0);
		expectValid(REVIEWED, d);
	});

	it('3 weeks late with a marathon 10 weeks out: the build shortened to 3 weeks, the taper fixed', () => {
		const d = dates({
			blocks: MARATHON,
			events: [RACE],
			today: '2026-11-18',
			start: 'next_monday'
		});
		expect(d.bridge?.weeks).toBe(3);
		expect(span(d.block)).toEqual(['2026-11-23', '2026-12-13']);
		expect(d.block.weeks).toBe(MIN_NEXT_BLOCK_WEEKS);
		expect(d.block.outline).toEqual(MARATHON[1]);
		expect(d.shifted).toEqual([MARATHON[2], MARATHON[3]]);
		expect(d.lostWeeks).toBe(0);
		expect(d.firstPlannedDay).toBe('2026-11-23');
		expectValid(MARATHON[0]!, d);
	});

	it('later before the marathon: the peak gives weeks too, then the build below its minimum', () => {
		const five = dates({ blocks: MARATHON, events: [RACE], today: '2026-12-09' });
		expect([five.block.weeks, ...five.shifted.map(span)]).toEqual([
			3,
			['2026-12-28', '2027-01-03'],
			span(MARATHON[3]!)
		]);
		expect(five.lostWeeks).toBe(0);
		expectValid(MARATHON[0]!, five);
		const six = dates({ blocks: MARATHON, events: [RACE], today: '2026-12-16' });
		expect([six.block.weeks, six.shifted[0]!.phase, six.shifted[1]]).toEqual([
			2,
			'marathon_peak',
			MARATHON[3]
		]);
		expect(six.lostWeeks).toBe(1);
		expectValid(MARATHON[0]!, six);
	});

	it('too late for the taper: it starts this week, still ending on race week, and lostWeeks says so', () => {
		const d = dates({ blocks: MARATHON, events: [RACE], today: '2027-01-13' });
		expect(d.bridge?.weeks).toBe(10);
		expect(span(d.block)).toEqual(['2027-01-11', '2027-01-24']);
		expect(d.block.outline).toEqual(MARATHON[3]);
		expect(d.shifted).toEqual([]);
		// The build's 3 and the peak's 1 minimum weeks, and a week of the taper.
		expect(d.lostWeeks).toBe(5);
		expectValid(MARATHON[0]!, d);
	});

	it('a half’s 2-week peak before its taper: no weeks lost on time, 1 when 1 week late', () => {
		const half = [
			{ ...REVIEWED, phase: 'half_build' as const },
			block('marathon_peak', NEXT, 2),
			block('half_taper', '2026-11-16', 2)
		];
		const onTime = dates({ blocks: half, events: ['2026-11-29'], today: NEXT });
		expect([onTime.block.weeks, onTime.lostWeeks]).toEqual([2, 0]);
		const late = dates({ blocks: half, events: ['2026-11-29'], today: '2026-11-09' });
		expect([late.block.weeks, late.lostWeeks]).toEqual([1, 1]);
		expectValid(half[0]!, late);
	});

	it('a 19-week build: the first 16 weeks planned, the other 3 left as outline', () => {
		const long = [REVIEWED, block('marathon_build', NEXT, 19)];
		const d = dates({ blocks: long, today: NEXT });
		expect(d.block.weeks).toBe(MAX_NEXT_BLOCK_WEEKS);
		expect(span(d.block)).toEqual([NEXT, addDays(NEXT, 7 * 16 - 1)]);
		expect(d.shifted).toEqual([{ ...long[1]!, startsOn: addDays(NEXT, 7 * 16) }]);
		expectValid(REVIEWED, d);
	});

	it('next Monday when on time: a 1-week bridge', () => {
		const d = dates({ today: '2026-11-04', start: 'next_monday' });
		expect(d.bridge).toEqual({ startsOn: NEXT, endsOn: '2026-11-08', weeks: 1 });
		expect(span(d.block)).toEqual(['2026-11-09', '2026-12-06']);
		expect(d.firstPlannedDay).toBe('2026-11-09');
		expectValid(REVIEWED, d);
	});

	it('no outline left: the block is appended from the start with the directed weeks', () => {
		const d = dates({ blocks: [REVIEWED], today: '2026-11-11', weeks: 5 });
		expect(d.bridge?.weeks).toBe(1);
		expect(span(d.block)).toEqual(['2026-11-09', '2026-12-13']);
		expect(d.block).toMatchObject({ weeks: 5, outline: null });
		expect(d.shifted).toEqual([]);
		expectValid(REVIEWED, d);
	});

	it('refuses a reviewed block that is not there', () => {
		expect(() => dates({ reviewedBlock: 7 })).toThrow(RangeError);
	});
});
