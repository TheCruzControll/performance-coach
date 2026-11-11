/**
 * Next week's card as load.ts arranges it (nextWeekView), on hand-built views: every state a
 * review's decision can be in, with its words and links, each change with its half step and
 * whether its session has passed, and a half step's values in the units its row uses.
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
