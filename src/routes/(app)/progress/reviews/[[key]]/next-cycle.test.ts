/**
 * The next block's card (next-cycle-data.ts nextCycleView, NextCycleCard.svelte as the server
 * renders it, and the form forms/reviews.ts cycleChoicesOf reads), on hand-built views:
 * - open: each start's label and when it starts ('Starts today, Wednesday'), its block, a late
 *   start's bridge in the program's weeks and the weeks lost before a race, week 1 as seven days
 *   with its sessions, and its decisions grouped (what changes and why once each, the exercises,
 *   the starting loads labelled estimated, the targets and deload); the rotated exercises to keep
 *   and the deload's choices
 * - folded, applied, decided elsewhere, superseded; legacy and nothing to decide show no card
 * - the card's form: every start's fingerprint, the chosen start's preview, keep and deload as
 *   named fields, and the chosen start's fingerprint is the one posted
 */
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { cycleChoicesOf } from '#lib/server/forms/reviews.ts';
import type { CycleReviewView, NextBlockPreview } from '#lib/server/services/reviews/index.ts';
import NextCycleCard from './NextCycleCard.svelte';
import { nextCycleView, type NextCycleView } from './next-cycle-data.ts';

/** A Wednesday. */
const TODAY = '2026-11-18';
const HEAD = '0b7e2d4c-1a3f-4e5d-9c6b-8a7f6e5d4c3b';
const BENCH = '5a1f0c9e-2b3d-4e6f-8a7b-9c0d1e2f3a4b';

const session = (date: string, title: string, type = 'strength') => ({
	date,
	title,
	type,
	kind: type === 'easy_run' ? 'run' : 'strength',
	customDiscipline: null,
	estMinutes: 60,
	intensity: 'moderate',
	timeOfDay: 'evening'
});
const week = (startsOn: string, endsOn: string, kind: string, sessions: unknown[] = []) => ({
	kind,
	startsOn,
	endsOn,
	targets: {},
	sessions
});
const decision = (kind: string, summary: string, why: string, ruleKey = `rule.${kind}`) => ({
	kind,
	ruleKey,
	summary,
	why,
	decidedBy: 'rules',
	refs: ['blocks.0'],
	evidence: {}
});

/** 'This week' on Wednesday, two weeks late before a race: a bridge, and a week lost. */
const THIS_WEEK = {
	start: 'this_week',
	fingerprint: 'fp-this-week',
	dates: {
		bridge: { startsOn: '2026-11-02', endsOn: '2026-11-15', weeks: 2 },
		block: { startsOn: '2026-11-16', endsOn: '2026-12-13', weeks: 4, outline: null },
		shifted: [],
		lostWeeks: 1,
		firstPlannedDay: TODAY
	},
	block: {
		phase: 'intensification',
		name: 'Build',
		startsOn: '2026-11-16',
		endsOn: '2026-12-13',
		outline: false,
		goalRefs: [],
		progression: {},
		weeks: [
			week('2026-11-16', '2026-11-22', 'build', [
				session('2026-11-18', 'Strength A'),
				session('2026-11-18', 'Easy run', 'easy_run'),
				session('2026-11-20', 'Strength B')
			]),
			week('2026-11-23', '2026-11-29', 'build'),
			week('2026-11-30', '2026-12-06', 'build'),
			week('2026-12-07', '2026-12-13', 'deload')
		]
	},
	decisions: [
		decision('next_block_planned', 'Next block: Build, from Wed 18 Nov', 'Build starts today.'),
		decision('exercise_kept', 'Kept Back squat for the squat', 'Back squat stays: progressing.'),
		decision('exercise_rotated', 'Floor press instead of Bench press', 'Bench press stalled.'),
		decision(
			'load_basis',
			'Back squat: your estimated 1RM of 140 kg',
			'Back squat is loaded from your estimated 1RM.',
			'loads.estimated'
		),
		decision('load_basis', 'Deadlift: your measured 1RM of 180 kg', 'Tested.', 'loads.measured'),
		decision('deload_scheduled', 'Deload in week 4', 'Week 4 is a deload.')
	],
	significantChanges: [
		{ kind: 'swap', subject: 'Bench press', from: 'Bench press', to: 'Floor press', decision: 2 },
		{ kind: 'deload', subject: 'Build', from: null, to: 4, decision: 5 },
		{ kind: 'swap', subject: 'Bench press', from: null, to: null, decision: 2 }
	]
} as unknown as NextBlockPreview;

const NEXT_MONDAY = {
	...THIS_WEEK,
	start: 'next_monday',
	fingerprint: 'fp-next-monday',
	dates: {
		...THIS_WEEK.dates,
		bridge: { startsOn: '2026-11-02', endsOn: '2026-11-22', weeks: 3 },
		lostWeeks: 0,
		firstPlannedDay: '2026-11-23'
	},
	block: {
		...THIS_WEEK.block,
		startsOn: '2026-11-23',
		endsOn: '2026-12-20',
		weeks: [
			week('2026-11-23', '2026-11-29', 'build', [session('2026-11-24', 'Strength A')]),
			...THIS_WEEK.block.weeks.slice(2),
			week('2026-12-14', '2026-12-20', 'deload')
		]
	},
	significantChanges: []
} as unknown as NextBlockPreview;

/** A review judging an accessory (bench, here) stalled and squat progressing. */
const SNAPSHOT = {
	block: { phase: 'accumulation', from: '2026-10-05', to: '2026-11-01', weeks: 4 },
	adherence: { planned: 24, completed: 24, pct: 100, verdictsWithheld: false, oftenMissed: [] },
	effectiveness: [
		{ exercise: BENCH, main: false, verdict: 'held', exposures: 8, stalled: true },
		{ exercise: 'squat-id', main: true, verdict: 'progressed', exposures: 8, stalled: false }
	],
	volume: [],
	fatigue: { level: 'none', reasons: [], deloadPlanned: false },
	deloadNeed: { verdict: 'none', reasons: [] },
	goals: [],
	brief: {
		findings: [
			{ id: `effectiveness:${BENCH}`, label: 'Bench press' },
			{ id: 'effectiveness:squat-id', label: 'Back squat (main lift)' }
		]
	}
};

function view(parts: Record<string, unknown> = {}): CycleReviewView {
	return {
		legacy: false,
		snapshot: SNAPSHOT,
		proposal: {
			id: HEAD,
			revisionOf: null,
			decisionNote: null,
			rows: [
				{ label: 'Next block', after: 'Intensification, 4 weeks' },
				{ label: 'Focus', after: 'Intensification: 4 weeks' },
				{ label: 'Targets', after: 'RPE cap 8, volume ×1' },
				{ label: 'Running', after: '20 km a week' }
			]
		},
		decision: { state: 'undecided', proposalId: HEAD },
		previews: [THIS_WEEK, NEXT_MONDAY],
		...parts
	} as unknown as CycleReviewView;
}

const open = (parts: Record<string, unknown> = {}, programStartsOn: string | null = '2026-10-05') =>
	nextCycleView(view(parts), { today: TODAY, programStartsOn })!;

describe("the next block's card", () => {
	it('open: each start says when it starts, its block, and what a late start costs', () => {
		const card = open();
		expect(card).toMatchObject({ state: 'open', title: 'Your next block', folded: false });
		expect(
			card.previews.map((p) => [p.start, p.label, p.hint, p.fingerprint, p.title, p.dates])
		).toEqual([
			[
				'this_week',
				'This week',
				'Starts today, Wednesday',
				'fp-this-week',
				'Build · Intensification',
				'Mon 16 Nov – Sun 13 Dec · 4 weeks'
			],
			[
				'next_monday',
				'Next Monday',
				'Starts Mon 23 Nov',
				'fp-next-monday',
				'Build · Intensification',
				'Mon 23 Nov – Sun 20 Dec · 4 weeks'
			]
		]);
		// The program started 5 Oct: the bridge from 2 Nov is its weeks 5 on.
		expect(card.previews[0]!.notes).toEqual([
			{ id: 'bridge', words: 'Weeks 5–6 stay unplanned' },
			{ id: 'lost', words: 'Your build is 1 week shorter before the race' }
		]);
		expect(card.previews[1]!.notes).toEqual([{ id: 'bridge', words: 'Weeks 5–7 stay unplanned' }]);
		// With the program's start unknown, the bridge is counted in weeks alone.
		expect(open({}, null).previews[1]!.notes[0]!.words).toBe(
			'3 weeks between blocks stay unplanned'
		);
	});

	it('week 1: seven days from Monday with their sessions, open on the first planned day', () => {
		const { week } = open().previews[0]!;
		expect(week.days.map((d) => d.short)).toEqual([
			'Mon',
			'Tue',
			'Wed',
			'Thu',
			'Fri',
			'Sat',
			'Sun'
		]);
		expect(week.days[2]!.name).toBe('Wednesday 18 November, today, 2 sessions');
		expect(week.days[0]!.name).toBe('Monday 16 November, no sessions');
		expect(week.days[2]!.dots).toHaveLength(2);
		expect(week).toMatchObject({ today: TODAY, first: TODAY });
		expect(week.sessions.map((s) => [s.date, s.title])).toEqual([
			[TODAY, 'Strength A'],
			[TODAY, 'Easy run'],
			['2026-11-20', 'Strength B']
		]);
		expect(week.sessions[0]!.line).toMatch(/^Strength · 60 min/);
		// Next Monday's week 1 is not this week: no today in it.
		expect(open().previews[1]!.week.today).toBeNull();
	});

	it('its decisions grouped: each significant change once, exercises, loads labelled, targets', () => {
		const groups = open().previews[0]!.groups;
		const of = (id: string) => groups.find((g) => g.id === id)!.items;
		expect(groups.map((g) => g.title)).toEqual([
			'What changes and why',
			'Exercises',
			'Starting loads',
			'Targets and deload'
		]);
		expect(of('changes').map((i) => [i.label, i.words])).toEqual([
			['Floor press instead of Bench press', 'Bench press stalled.'],
			['Deload in week 4', 'Week 4 is a deload.']
		]);
		expect(of('exercises').map((i) => i.label)).toEqual([
			'Kept Back squat for the squat',
			'Floor press instead of Bench press'
		]);
		expect(of('loads').map((i) => [i.label, i.badge])).toEqual([
			['Back squat: your estimated 1RM of 140 kg', 'Estimated'],
			['Deadlift: your measured 1RM of 180 kg', null]
		]);
		expect(of('targets').map((i) => [i.label, i.words])).toEqual([
			['Targets', 'RPE cap 8, volume ×1'],
			['Running', '20 km a week'],
			['Deload in week 4', 'Week 4 is a deload.']
		]);
		// Nothing significant still says so.
		expect(open().previews[1]!.groups[0]!.items[0]!.label).toBe('Nothing changes much');
	});

	it('the overrides: each rotated exercise to keep, and the deload moved or skipped', () => {
		const card = open();
		expect(card.rotated).toEqual([
			{ value: BENCH, label: 'Keep Bench press', hint: expect.stringMatching(/^Stalled/) }
		]);
		expect(card.deload).toEqual([
			{ value: 'planned', label: 'As planned · week 4' },
			{ value: 'first', label: 'Move it to the first week' },
			{ value: 'none', label: 'Skip the deload' }
		]);
		// A block with no deload has nothing to move.
		const flat = {
			...THIS_WEEK,
			block: { ...THIS_WEEK.block, weeks: THIS_WEEK.block.weeks.slice(0, 3) }
		};
		expect(open({ previews: [flat] }).deload).toBeNull();
	});

	it('folded: the head is a revision of the review’s own proposal', () => {
		const card = open({ proposal: { ...view().proposal!, revisionOf: 'own-proposal' } });
		expect(card.folded).toBe(true);
	});

	it('decided: applied with the plan, decided elsewhere, superseded; else no card', () => {
		const decided = (decision: unknown, proposal?: unknown) =>
			nextCycleView(view({ decision, previews: [], ...(proposal ? { proposal } : {}) }), {
				today: TODAY,
				programStartsOn: null
			});
		expect(decided({ state: 'applied', versionNumber: 3 })).toMatchObject({
			state: 'applied',
			title: 'Next block planned · version 3',
			link: { href: '/train?tool=plan', label: 'Open your plan' },
			previews: []
		});
		expect(decided({ state: 'rejected' })).toMatchObject({
			state: 'decided_elsewhere',
			title: 'Next block not planned',
			words: 'You turned it down from your coach inbox, so your plan stays as it is.'
		});
		expect(
			decided({ state: 'rejected' }, { ...view().proposal!, decisionNote: 'Taking a break' })
		).toMatchObject({ words: 'Taking a break' });
		expect(decided({ state: 'superseded', reason: 'new_program' })).toMatchObject({
			state: 'superseded',
			title: 'Your plan changed since this review'
		});
		expect(decided({ state: 'undecided' })).toBeNull();
		expect(decided({ state: 'none' })).toBeNull();
		expect(nextCycleView(view({ legacy: true }), { today: TODAY, programStartsOn: null })).toBe(
			null
		);
	});
});

describe("the card's form", () => {
	const html = (next: NextCycleView) =>
		render(NextCycleCard, { props: { next, reviewId: 'review-1' } }).body;

	it('every start’s fingerprint, the chosen preview; keep and deload post as named fields', () => {
		const body = html(open());
		expect(body).toMatch(/<form method="POST" action="\?\/startCycle"/);
		expect(body).toContain('name="reviewId" value="review-1"');
		expect(body).toMatch(/type="radio" name="start" value="this_week"[^>]*checked/);
		expect(body).toMatch(/type="radio" name="start" value="next_monday"/);
		expect(body).toContain('name="fingerprint:this_week" value="fp-this-week"');
		expect(body).toContain('name="fingerprint:next_monday" value="fp-next-monday"');
		// The chosen start's preview alone: this week's, with its bridge.
		expect(body.match(/data-testid="next-cycle-preview"/g)).toHaveLength(1);
		expect(body).not.toContain('Weeks 5–7 stay unplanned');
		expect(body).toMatch(new RegExp(`type="checkbox" name="keep" value="${BENCH}"`));
		expect(body).toMatch(/type="radio" name="deload" value="planned"[^>]*checked/);
		expect(body).toContain('Weeks 5–6 stay unplanned');
		expect(body).toMatch(/class="badge[^>]*>(<!--[^>]*-->|\s)*Estimated/);
		expect(body).toContain('data-testid="next-cycle-start-block"');
		expect(body).toContain('href="/progress/reviews"');
	});

	it('one start: posted as it is, saying when it starts', () => {
		const body = html(open({ previews: [NEXT_MONDAY] }));
		expect(body).toContain('type="hidden" name="start" value="next_monday"');
		expect(body).not.toContain('type="radio" name="start"');
		expect(body).toContain('Starts Mon 23 Nov · Mon 23 Nov – Sun 20 Dec · 4 weeks');
	});

	it('decided: no form, the words and the link', () => {
		const body = html(
			nextCycleView(view({ decision: { state: 'applied', versionNumber: 3 }, previews: [] }), {
				today: TODAY,
				programStartsOn: null
			})!
		);
		expect(body).not.toContain('<form');
		expect(body).toContain('Next block planned · version 3');
		expect(body).toContain('href="/train?tool=plan"');
	});

	it('the chosen start’s fingerprint is the one posted, with the overrides only when given', () => {
		const form = new FormData();
		form.set('reviewId', 'review-1');
		form.set('start', 'next_monday');
		form.set('fingerprint:this_week', 'fp-this-week');
		form.set('fingerprint:next_monday', 'fp-next-monday');
		form.set('deload', 'planned');
		expect(cycleChoicesOf(form)).toEqual({
			reviewId: 'review-1',
			input: { start: 'next_monday', fingerprint: 'fp-next-monday' }
		});
		form.append('keep', BENCH);
		form.append('keep', BENCH);
		form.set('deload', 'none');
		expect(cycleChoicesOf(form).input).toEqual({
			start: 'next_monday',
			fingerprint: 'fp-next-monday',
			overrides: { keep: [BENCH], deload: 'none' }
		});
	});
});
