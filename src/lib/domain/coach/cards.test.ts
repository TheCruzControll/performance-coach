import { describe, expect, it } from 'vitest';
import { cardOf, cardState, NEXT_CYCLE_WAITS, parseCard, type ProposalCardView } from './cards.ts';

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
