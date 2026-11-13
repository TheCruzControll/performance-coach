import { describe, expect, it } from 'vitest';
import {
	cardOf,
	cardState,
	CHOOSE_START,
	NEXT_CYCLE_WAITS,
	parseCard,
	type ProposalCardView
} from './cards.ts';

/** A proposal view as the server sends it: more than a card reads. */
const view = {
	id: '9b2f4d4e-5f0a-4d47-9a43-0c1d2b3a4e5f',
	kind: 'program_adjustment',
	status: 'proposed',
	title: 'Swap Bulgarian split squats for leg press',
	summary: 'Bulgarian split squat → Leg press',
	rationale: 'You said you dislike them.',
	summaryLines: ['Bulgarian split squat → Leg press'],
	rows: [
		{
			area: 'exercise',
			label: 'Lower body strength',
			before: 'Bulgarian split squat',
			after: 'Leg press',
			date: '2026-11-12',
			link: { type: 'session', id: 's1' }
		}
	],
	impact: [{ weekStart: '2026-11-09', hardSets: {}, minutes: -4, load: 0, runMetres: 0 }],
	impactLines: ['Week of Mon 9 Nov: −4 min'],
	warnings: [],
	appliedVersion: null,
	appliedRef: null,
	decisionNote: 'never shown',
	supersededReason: null,
	threadId: 't1',
	revisionOf: null,
	origin: null,
	createdAt: '2026-11-10T09:00:00.000Z',
	closedAt: null,
	links: [{ type: 'session', id: 's1' }]
} as const;

const card = (over: Partial<ProposalCardView> = {}): ProposalCardView => ({
	...cardOf(view),
	...over
});

describe('cardOf', () => {
	it('keeps what the card shows, and drops links, notes and dates', () => {
		expect(cardOf(view)).toEqual({
			id: view.id,
			kind: 'program_adjustment',
			status: 'proposed',
			title: 'Swap Bulgarian split squats for leg press',
			rationale: 'You said you dislike them.',
			rows: [
				{
					label: 'Lower body strength',
					before: 'Bulgarian split squat',
					after: 'Leg press',
					date: '2026-11-12'
				}
			],
			impactLines: ['Week of Mon 9 Nov: −4 min'],
			warnings: [],
			appliedVersion: null,
			supersededReason: null
		});
	});

	it('names the version applying it made by its number', () => {
		const applied = { ...view, status: 'applied', appliedVersion: { id: 'v', number: 3 } } as const;
		expect(cardOf(applied).appliedVersion).toBe(3);
	});
});

describe('parseCard', () => {
	it('reads an Accept’s answer through JSON', () => {
		expect(parseCard(JSON.parse(JSON.stringify(view)))).toEqual(cardOf(view));
	});

	it.each([
		['nothing', null],
		['a string', 'applied'],
		['an unknown status', { ...view, status: 'done' }],
		['no title', { ...view, title: undefined }],
		['rows that are not rows', { ...view, rows: ['Leg press'] }],
		['impact that is not words', { ...view, impactLines: [3] }],
		['a version with no number', { ...view, appliedVersion: { id: 'v' } }],
		['an unknown superseded reason', { ...view, supersededReason: 'because' }]
	])('refuses %s', (_, value) => {
		expect(parseCard(value)).toBeNull();
	});
});

describe('cardState', () => {
	it('offers Accept while it is proposed', () => {
		expect(cardState(card())).toEqual({ kind: 'proposed' });
	});

	it('names the version an applied program change made', () => {
		expect(cardState(card({ status: 'applied', appliedVersion: 4 }))).toEqual({
			kind: 'applied',
			words: 'Applied as version 4',
			version: 4
		});
	});

	it('says applied, with no version, for a change outside the program', () => {
		expect(cardState(card({ kind: 'preference_update', status: 'applied' }))).toEqual({
			kind: 'applied',
			words: 'Applied',
			version: null
		});
	});

	it('waits for the cycle review once a next cycle is accepted', () => {
		expect(cardState(card({ kind: 'next_cycle', status: 'accepted' }))).toEqual({
			kind: 'waiting',
			words: NEXT_CYCLE_WAITS
		});
		expect(NEXT_CYCLE_WAITS).toBe('Waits for your cycle review');
	});

	it('says why it was superseded', () => {
		expect(cardState(card({ status: 'superseded', supersededReason: 'program_changed' }))).toEqual({
			kind: 'superseded',
			words: 'The program changed since it was proposed'
		});
	});

	it('says it was declined', () => {
		expect(cardState(card({ status: 'rejected' }))).toEqual({
			kind: 'rejected',
			words: 'Declined'
		});
	});
});

describe("M6's reviews on the card", () => {
	const weekly = {
		...view,
		threadId: null,
		origin: {
			kind: 'weekly_review',
			href: '/progress/reviews/w-2026-11-02',
			weekStartsOn: '2026-11-02'
		}
	} as const;
	const cycleHref = '/progress/reviews/c-7d0f0b8e-1a2b-4c3d-8e9f-0a1b2c3d4e5f';

	it('names the review a proposal came from, with its week, and links to it', () => {
		expect(cardOf(weekly).origin).toEqual({
			words: 'From your weekly review · Week of 2 Nov',
			href: '/progress/reviews/w-2026-11-02'
		});
		const cycle = { ...view, origin: { kind: 'cycle_review', href: cycleHref } } as const;
		expect(cardOf(cycle).origin).toEqual({ words: 'From your cycle review', href: cycleHref });
		expect(cardOf(view).origin).toBeUndefined();
	});

	it.each([
		['review_refreshed', 'Replaced by a refreshed review', 'open'],
		['sessions_passed', 'Some sessions have passed', 'Finish in your weekly review']
	] as const)('labels %s and links it to the review', (reason, words, link) => {
		const superseded = { ...weekly, status: 'superseded', supersededReason: reason } as const;
		expect(cardState(cardOf(superseded))).toEqual({
			kind: 'superseded',
			words,
			link: { words: link, href: '/progress/reviews/w-2026-11-02' }
		});
	});

	it.each([
		['folded_into_review', 'Folded into your cycle review'],
		['cycle_planned', 'Your next block is already planned']
	] as const)('labels a coach next cycle %s and links it to the cycle review', (reason, words) => {
		const coach = {
			...view,
			kind: 'next_cycle',
			status: 'superseded',
			supersededReason: reason,
			cycleReview: { href: cycleHref }
		} as const;
		expect(cardOf(coach).origin).toBeUndefined();
		expect(cardState(cardOf(coach))).toEqual({
			kind: 'superseded',
			words,
			link: { words: 'open', href: cycleHref }
		});
	});

	it('leaves the coach’s own superseded reasons unlinked', () => {
		const revised = { ...weekly, status: 'superseded', supersededReason: 'revised' } as const;
		expect(cardState(cardOf(revised))).toEqual({
			kind: 'superseded',
			words: 'Replaced by a revised proposal'
		});
	});

	it('links a waiting next cycle to the cycle review once there is one', () => {
		const waiting = { ...view, kind: 'next_cycle', status: 'accepted' } as const;
		expect(cardState(cardOf(waiting))).toEqual({ kind: 'waiting', words: NEXT_CYCLE_WAITS });
		expect(cardState(cardOf({ ...waiting, cycleReview: { href: cycleHref } }))).toEqual({
			kind: 'waiting',
			words: NEXT_CYCLE_WAITS,
			href: cycleHref
		});
	});

	it("offers the review's own next cycle in the review instead of Accept", () => {
		const own = {
			...view,
			kind: 'next_cycle',
			origin: { kind: 'cycle_review', href: cycleHref },
			chooseStart: { href: cycleHref }
		} as const;
		expect(cardState(cardOf(own))).toEqual({
			kind: 'choose',
			words: CHOOSE_START,
			href: cycleHref
		});
		expect(CHOOSE_START).toBe('Choose when it starts in your cycle review');
	});

	it('keeps the review links through JSON, and refuses a link off the app', () => {
		const own = { ...weekly, chooseStart: null, cycleReview: null };
		expect(parseCard(JSON.parse(JSON.stringify(own)))).toEqual(cardOf(own));
		for (const href of ['https://evil.example/', '//evil.example/', 'javascript:alert(1)']) {
			expect(parseCard({ ...weekly, origin: { ...weekly.origin, href } })).toBeNull();
			expect(parseCard({ ...view, cycleReview: { href } })).toBeNull();
		}
		expect(parseCard({ ...weekly, origin: { ...weekly.origin, kind: 'coach' } })).toBeNull();
	});
});
