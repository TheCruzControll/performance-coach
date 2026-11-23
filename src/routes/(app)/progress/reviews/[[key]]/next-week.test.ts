/**
 * Next week's card as load.ts arranges it (nextWeekView), on hand-built views: every state a
 * review's decision can be in, with its words and links, each change with its half step and
 * whether its session has passed, and a half step's values in the units its row uses. A proposed
 * deload is one card: its headline (computed from its week and today), the signals behind it, what
 * changes, and Propose again once it is stale or late.
 */
import { describe, expect, it } from 'vitest';
import type { ProgramOp } from '#lib/domain/coach/proposals.ts';
import type { NextWeekOffer, WeeklyReviewView } from '#lib/server/services/reviews/index.ts';
import { BUILD_LINK, CYCLE_REVIEW_LINK, halfWords, nextWeekView } from './load.ts';

/** A Thursday: Monday and Tuesday of next week have passed. */
const TODAY = '2026-11-19';
const HEAD = '0b7e2d4c-1a3f-4e5d-9c6b-8a7f6e5d4c3b';
const ROWS = [
	{
		label: 'Bench press, working',
		before: '3 × 5 @ RPE 8, 85 kg',
		after: '3 × 5 @ RPE 8, 87.5 kg'
	},
	{ label: 'Sparring', before: 'Fri 20 Nov, Evening', after: 'Sat 21 Nov, Evening' }
].map((r) => ({ ...r, area: 'set', date: null, link: null }));
const HALF = { op: 'adjust_set', loadValue: 86.25 } as unknown as ProgramOp;
const NOT_PROPOSED = {
	id: 'next:not_proposed:rpe:x',
	section: 'next',
	label: 'Squat felt harder than prescribed',
	figures: [],
	verdict: { level: 'neutral', words: 'It would take the session to 75 minutes, over your 60' },
	window: null,
	metricId: null,
	sources: []
};

function view(parts: Record<string, unknown>): WeeklyReviewView {
	return {
		legacy: false,
		proposal: { id: HEAD, rows: ROWS, decisionNote: null },
		decision: { state: 'undecided', proposalId: HEAD },
		noProposal: null,
		notProposed: [NOT_PROPOSED],
		...parts
	} as unknown as WeeklyReviewView;
}

const offer = (id: string, sessionDate: string, ahead: boolean, halfStep: ProgramOp | null) =>
	({ id, sessionDate, why: `Why ${id}`, halfStep, ahead }) as NextWeekOffer;
const BENCH = offer('load:a:2', '2026-11-16', false, HALF);
const MOVE = offer('move:b', '2026-11-20', true, null);

describe("next week's card", () => {
	it('open: each change with its rows, why and half step; nothing passed', () => {
		const card = nextWeekView(view({}), [{ ...BENCH, ahead: true }, MOVE], TODAY)!;
		expect(card).toMatchObject({ state: 'open', title: 'Next week’s changes', words: null });
		expect(card.items).toEqual([
			{
				id: 'load:a:2',
				label: 'Bench press, working',
				before: '3 × 5 @ RPE 8, 85 kg',
				after: '3 × 5 @ RPE 8, 87.5 kg',
				why: 'Why load:a:2',
				half: '86.25 kg',
				passed: null
			},
			expect.objectContaining({ id: 'move:b', half: null, passed: null })
		]);
		expect(card.notProposed).toEqual([
			{
				id: NOT_PROPOSED.id,
				label: 'Squat felt harder than prescribed',
				words: 'It would take the session to 75 minutes, over your 60'
			}
		]);
	});

	it('partly past: a change whose day has passed says so, and how many are still ahead', () => {
		const card = nextWeekView(view({}), [BENCH, MOVE], TODAY)!;
		expect(card).toMatchObject({
			state: 'partly_past',
			title: 'Some sessions have passed — apply the rest?',
			words: '1 of 2 changes are still ahead.'
		});
		expect(card.items.map((i) => i.passed)).toEqual(['Monday has passed', null]);
	});

	it('partly past from the inbox, even with every remaining change ahead', () => {
		const decision = { state: 'partly_past', proposalId: HEAD };
		const card = nextWeekView(view({ decision }), [{ ...BENCH, ahead: true }], TODAY)!;
		expect(card).toMatchObject({ state: 'partly_past', words: '1 of 1 change is still ahead.' });
	});

	it('a session that started today is not ahead either', () => {
		const card = nextWeekView(view({}), [{ ...MOVE, sessionDate: TODAY, ahead: false }], TODAY)!;
		expect(card.items[0]!.passed).toBe('Thursday’s session has started');
	});

	it('all past: too late, the changes struck through', () => {
		const card = nextWeekView(view({}), [BENCH, { ...MOVE, ahead: false }], TODAY)!;
		expect(card).toMatchObject({ state: 'all_past', title: 'Too late to change next week' });
		expect(card.items).toHaveLength(2);
	});

	it('nothing proposed: no ops, no program (to the build), a boundary (to the cycle review), late', () => {
		const none = (reason: string, words = `Stored words for ${reason}`) =>
			nextWeekView(
				view({ decision: { state: 'none' }, proposal: null, noProposal: { reason, words } }),
				[],
				TODAY
			)!;
		expect(none('no_changes')).toMatchObject({
			state: 'no_ops',
			title: 'Next week stays as planned',
			words: 'Stored words for no_changes',
			link: null
		});
		expect(none('no_program')).toMatchObject({
			state: 'no_program',
			title: 'Build a program to get adjustments',
			words: 'No program plans next week. Once one does, each review proposes its changes here.',
			link: BUILD_LINK
		});
		expect(none('boundary')).toMatchObject({
			state: 'boundary',
			title: 'Next week starts a new block',
			link: CYCLE_REVIEW_LINK
		});
		expect(none('late')).toMatchObject({
			state: 'late',
			title: 'This review came after next week ended',
			link: null
		});
	});

	it('applied (here or in the inbox): its version and the link to History', () => {
		const decision = { state: 'applied', proposalId: HEAD, versionId: 'v', versionNumber: 4 };
		const card = nextWeekView(view({ decision }), [], TODAY)!;
		expect(card).toMatchObject({
			state: 'applied',
			title: 'Next week updated · version 4',
			link: { href: '/train/history/4', label: 'See version 4 in History' },
			items: []
		});
	});

	it('rejected with its note or without; superseded; waiting', () => {
		const rejected = { state: 'rejected', proposalId: HEAD };
		const note = { id: HEAD, rows: ROWS, decisionNote: 'A race on Saturday' };
		expect(nextWeekView(view({ decision: rejected, proposal: note }), [], TODAY)).toMatchObject({
			state: 'rejected',
			title: 'Kept as planned',
			words: 'A race on Saturday'
		});
		expect(nextWeekView(view({ decision: rejected }), [], TODAY)).toMatchObject({
			words: 'Next week stays as planned.'
		});
		const superseded = { state: 'superseded', proposalId: HEAD, reason: 'program_changed' };
		expect(nextWeekView(view({ decision: superseded }), [], TODAY)).toMatchObject({
			state: 'superseded',
			title: 'Your plan changed since this review'
		});
		const waiting = { state: 'accepted_waiting', proposalId: HEAD };
		expect(nextWeekView(view({ decision: waiting }), [], TODAY)).toMatchObject({
			state: 'waiting'
		});
	});

	it('a review written before M6 has no card', () => {
		expect(nextWeekView(view({ legacy: true }), [], TODAY)).toBeNull();
	});
});

describe("a proposed deload's card (a replan head)", () => {
	/** A row the deload leaves out: its own card would say it is not proposed, so it is not shown. */
	const INSTEAD = {
		...NOT_PROPOSED,
		id: 'next:not_proposed:load:a:2',
		label: 'Bench press, working',
		verdict: {
			level: 'neutral',
			words: 'Next week is proposed as a deload instead, so this change is not proposed'
		}
	};
	/** A replan head as the card reads it: cardOf reads every field of a proposal. */
	const replan = (parts: Record<string, unknown> = {}) => ({
		id: HEAD,
		kind: 'replan',
		status: 'proposed',
		title: 'Deload the week of 30 Nov',
		rationale: 'Fatigue is high',
		rows: [],
		impactLines: [],
		warnings: [],
		appliedVersion: null,
		supersededReason: null,
		decisionNote: null,
		...parts
	});
	/** The snapshot a deload's card reads: its week and reasons, and the review's fatigue. */
	const snapshot = (
		week: string,
		reasons: string[] = ['slept 5 hours'],
		fatigue: string[] = []
	) => ({
		deload: { week, reasons },
		fatigue: { level: 'high', reasons: fatigue },
		brief: { findings: [] }
	});
	const deloadView = (parts: Record<string, unknown>) =>
		view({
			proposal: replan(),
			snapshot: snapshot('2026-11-30'),
			notProposed: [INSTEAD],
			...parts
		});
	/** A card with no rows or lines, and its evidence. */
	const NO_CHANGES = { rows: [], more: null, lines: [] };

	it('undecided: one card, its headline, the signals and what changes, with Accept and Keep, no changes to tick', () => {
		// A deload has no changes, so offers are not listed either, and the card is never 'all past'.
		const card = nextWeekView(deloadView({}), [MOVE], TODAY)!;
		expect(card).toEqual({
			state: 'deload',
			title: 'Week of 30 Nov becomes a deload week',
			words: null,
			items: [],
			notProposed: [],
			link: null,
			deload: { evidence: ['slept 5 hours'], ...NO_CHANGES }
		});
	});

	it('the headline is this week from today, next week, or the week by date, read on the day it is shown', () => {
		const titleOf = (week: string, today: string) =>
			nextWeekView(deloadView({ snapshot: snapshot(week) }), [], today)!.title;
		const THIS_WEEK = 'This week becomes a deload week from today';
		// Thursday 19 Nov: this week is the week of 16 Nov, next week the week of 23 Nov.
		expect(titleOf('2026-11-16', TODAY)).toBe(THIS_WEEK);
		expect(titleOf('2026-11-23', TODAY)).toBe('Next week becomes a deload week');
		expect(titleOf('2026-11-30', TODAY)).toBe('Week of 30 Nov becomes a deload week');
		expect(titleOf('2026-11-09', TODAY)).toBe('Week of 9 Nov becomes a deload week');
		// A review made on the Monday of the deload week reads 'This week'.
		expect(titleOf('2026-11-16', '2026-11-16')).toBe(THIS_WEEK);
		// Sunday is still the week of 16 Nov; the Monday after it starts next week.
		expect(titleOf('2026-11-16', '2026-11-22')).toBe(THIS_WEEK);
		expect(titleOf('2026-11-23', '2026-11-22')).toBe('Next week becomes a deload week');
		// Tuesday 24 Nov: the week of 23 Nov is this week, and the week of 16 Nov is by date.
		expect(titleOf('2026-11-23', '2026-11-24')).toBe(THIS_WEEK);
		expect(titleOf('2026-11-16', '2026-11-24')).toBe('Week of 16 Nov becomes a deload week');
	});

	it('the evidence is the signals the deload stored, at most five; the fatigue reasons when none were stored', () => {
		const many = ['one', 'two', 'three', 'four', 'five', 'six'];
		expect(
			nextWeekView(deloadView({ snapshot: snapshot('2026-11-30', many) }), [], TODAY)!.deload
		).toMatchObject({ evidence: ['one', 'two', 'three', 'four', 'five'] });
		const fatigue = snapshot('2026-11-30', [], ['Soreness high on 3 days']);
		expect(nextWeekView(deloadView({ snapshot: fatigue }), [], TODAY)!.deload?.evidence).toEqual([
			'Soreness high on 3 days'
		]);
	});

	it('what changes: the proposal’s rows as the inbox shows them; its summary lines without the deload line', () => {
		const row = {
			label: 'Bench press, working',
			before: '3 × 5 @ 85 kg',
			after: '3 × 5 @ 70 kg',
			date: '2026-11-30',
			area: 'set',
			link: null
		};
		const card = nextWeekView(
			deloadView({
				proposal: replan({
					rows: [row],
					summaryLines: [
						'Bench press, working: 3 × 5 @ 85 kg → 3 × 5 @ 70 kg',
						'Week of 30 Nov becomes a deload week'
					]
				})
			}),
			[],
			TODAY
		)!;
		expect(card.deload).toMatchObject({
			rows: [
				{
					label: 'Bench press, working',
					before: '3 × 5 @ 85 kg',
					after: '3 × 5 @ 70 kg',
					date: '2026-11-30'
				}
			],
			lines: ['Bench press, working: 3 × 5 @ 85 kg → 3 × 5 @ 70 kg']
		});
	});

	it('superseded as the plan, the profile, the program or a start changed: out of date, with Propose again', () => {
		for (const reason of [
			'profile_changed',
			'plan_changed',
			'start_passed',
			'sessions_passed',
			'program_changed'
		]) {
			const decision = { state: 'superseded', proposalId: HEAD, reason };
			expect(nextWeekView(deloadView({ decision }), [], TODAY)).toMatchObject({
				state: 'superseded_deload',
				title: 'Week of 30 Nov becomes a deload week',
				words: 'This deload is out of date',
				deload: { evidence: ['slept 5 hours'] }
			});
		}
	});

	it('superseded for another reason is the plan changed card, with no deload detail', () => {
		// 'revised' is not a stale reason: the deload is replaced, not out of date.
		const decision = { state: 'superseded', proposalId: HEAD, reason: 'revised' };
		const card = nextWeekView(deloadView({ decision }), [], TODAY)!;
		expect(card).toMatchObject({
			state: 'superseded',
			title: 'Your plan changed since this review'
		});
		expect(card.deload).toBeUndefined();
	});

	it('undecided without a stored week: the title says only that a deload is proposed', () => {
		const card = nextWeekView(deloadView({ snapshot: null }), [], TODAY)!;
		expect(card).toMatchObject({ state: 'deload', title: 'A deload is proposed', words: null });
	});

	it('late: no session is left in that week, with the headline and Propose again', () => {
		const decision = { state: 'late', proposalId: HEAD };
		expect(nextWeekView(deloadView({ decision }), [], TODAY)).toEqual({
			state: 'late_deload',
			title: 'Week of 30 Nov becomes a deload week',
			words: 'No session is left in that week',
			items: [],
			notProposed: [],
			link: null,
			deload: { evidence: ['slept 5 hours'], ...NO_CHANGES }
		});
	});

	it('late in this week or next: the headline is by date only, so it never contradicts the status line', () => {
		// Thursday 19 Nov: the week of 16 Nov is this week, and the week of 23 Nov is next week.
		const LATE = { state: 'late', proposalId: HEAD };
		for (const [week, title] of [
			['2026-11-16', 'Week of 16 Nov becomes a deload week'],
			['2026-11-23', 'Week of 23 Nov becomes a deload week']
		] as const) {
			const card = nextWeekView(
				deloadView({ decision: LATE, snapshot: snapshot(week) }),
				[],
				TODAY
			)!;
			expect(card).toMatchObject({
				state: 'late_deload',
				title,
				words: 'No session is left in that week'
			});
		}
		// The same week, undecided, reads from today as it always did.
		const undecided = nextWeekView(deloadView({ snapshot: snapshot('2026-11-16') }), [], TODAY);
		expect(undecided?.title).toBe('This week becomes a deload week from today');
	});

	it('accepted: its version and the link to History, as any applied week', () => {
		const decision = { state: 'applied', proposalId: HEAD, versionId: 'v', versionNumber: 2 };
		expect(nextWeekView(deloadView({ decision }), [], TODAY)).toMatchObject({
			state: 'applied',
			title: 'Next week updated · version 2',
			link: { href: '/train/history/2', label: 'See version 2 in History' },
			notProposed: []
		});
	});

	it('kept: kept as planned, with the owner’s note', () => {
		const decision = { state: 'rejected', proposalId: HEAD };
		const proposal = replan({ decisionNote: 'Feeling fine' });
		expect(nextWeekView(deloadView({ decision, proposal }), [], TODAY)).toMatchObject({
			state: 'rejected',
			title: 'Kept as planned',
			words: 'Feeling fine'
		});
	});

	it('applied or kept, here or in the coach inbox: the same card, with no line about where it was decided', () => {
		const applied = { state: 'applied', proposalId: HEAD, versionId: 'v', versionNumber: 2 };
		const appliedCard = nextWeekView(deloadView({ decision: applied }), [], TODAY)!;
		expect(appliedCard).toMatchObject({ state: 'applied', title: 'Next week updated · version 2' });
		expect(appliedCard.deload).not.toHaveProperty('inbox');
		const rejected = { state: 'rejected', proposalId: HEAD };
		const keptCard = nextWeekView(
			deloadView({ decision: rejected, proposal: replan({ decisionNote: null }) }),
			[],
			TODAY
		)!;
		expect(keptCard).toMatchObject({ state: 'rejected', title: 'Kept as planned' });
		expect(keptCard.deload).not.toHaveProperty('inbox');
	});
});

describe('a half step in words', () => {
	const op = (fields: Record<string, number>) => fields as unknown as ProgramOp;
	it('names each value it changes, in the units of the row it changes', () => {
		expect(halfWords(op({ loadValue: 61.25 }), '3 × 5 @ 62.5 lb')).toBe('61.25 lb');
		expect(halfWords(op({ sets: 4, targetRpe: 7.5 }), '4 × 5 @ RPE 8')).toBe('4 sets · RPE 7.5');
		expect(halfWords(op({ repsMin: 6, repsMax: 8 }), null)).toBe('6–8 reps');
		expect(halfWords(op({ repsMin: 6, repsMax: 6 }), null)).toBe('6 reps');
		expect(halfWords(op({ distanceMetres: 3800 }), 'Easy 1.6 km')).toBe('3.8 km');
		expect(halfWords(op({ distanceMetres: 3218.688 }), 'Easy 1 mi')).toBe('2 mi');
		expect(halfWords(op({ durationSeconds: 1500 }), 'Easy 30 min')).toBe('25 min');
	});
});
