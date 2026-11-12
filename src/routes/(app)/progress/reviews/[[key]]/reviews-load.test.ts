/**
 * The reviews screen's load (load.ts) on hand-built service results: the key, the list newest
 * first with the due week, this week in progress and older weeks not reviewed yet, a stored
 * review's figures and verdicts as the screen shows them, a bad key or a missing review (404) set
 * apart from a failed read (recorded, then the load-failed state), and Create's answers.
 */
import { isHttpError } from '@sveltejs/kit';
import { describe, expect, it, vi } from 'vitest';
import { METRICS } from '#lib/domain/analytics/metrics.ts';
import type { Finding } from '#lib/domain/programming/review/brief.ts';
import type { WeeklyReviewSnapshot } from '#lib/domain/programming/review/snapshot.ts';
import {
	ReviewInputError,
	ReviewNotFoundError,
	ReviewSupersededError,
	WeeklyReviewNotReviewableError,
	WeeklyReviewRefreshError,
	type WeeklyReviewView
} from '#lib/server/services/reviews/index.ts';
import type { TrainingDeps } from '#lib/server/services/training/shared.ts';
import {
	createReview,
	findingVerdict,
	loadReviews,
	NOT_REVIEWED_MAX,
	parseReviewKey,
	refreshReview,
	reviewRows,
	weeklyReviewData,
	type ReviewsDeps
} from './load.ts';

/** A Wednesday: this week is from 2 Nov, last week from 26 Oct. */
const TODAY = '2026-11-04';
const THIS_WEEK = '2026-11-02';
const LAST_WEEK = '2026-10-26';
const ID = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
const origin = {
	requestId: 'req-1',
	method: 'GET',
	path: '/progress/reviews',
	routeId: '/(app)/progress/reviews/[[key]]',
	appVersion: 'test'
};
const db = {} as NonNullable<TrainingDeps['db']>;

const figure = (label: string, value: number | null, words: string, unit = 'sessions') => ({
	label,
	value,
	unit: unit as Finding['figures'][number]['unit'],
	kind: 'calculated' as const,
	words
});

function finding(id: string, parts: Partial<Finding> = {}): Finding {
	return {
		id,
		section: id.split(':')[0] as Finding['section'],
		label: id,
		figures: [],
		verdict: { level: 'neutral', words: 'Within normal variation' },
		window: { from: '2026-08-31', to: '2026-11-01', label: 'Trend over the last 9 weeks' },
		metricId: null,
		sources: [],
		...parts
	};
}

const ADHERENCE = finding('adherence', {
	label: 'Planned against completed',
	figures: [
		figure('Planned', 6, '6 sessions'),
		figure('Completed', 5, '5 sessions'),
		figure('Skipped', 1, '1 session'),
		figure('Missed', 0, '0 sessions'),
		figure('Adherence', 83.3, '83%', 'pct')
	],
	verdict: { level: 'good', words: '5 of 6 sessions done · On plan' },
	metricId: 'adherence'
});
const BENCH = finding('verdicts:e1rm:bench_press', {
	label: 'Bench press estimated 1RM',
	figures: [figure('Change', 5, '5 kg', 'kg')],
	verdict: { level: 'good', words: 'Trending up, improving' },
	metricId: 'e1rm'
});
const TONNAGE = finding('verdicts:tonnage', {
	label: 'Weekly tonnage',
	figures: [figure('Change', null, 'No change measured', 'kg')],
	verdict: { level: 'not_enough_data', words: 'Not enough data yet: 2 more weeks' },
	metricId: 'tonnage'
});

function view(parts: Partial<WeeklyReviewView> = {}, findings = [ADHERENCE, BENCH, TONNAGE]) {
	const snapshot = {
		adherence: { planned: 6, completed: 5, skipped: 1, missed: 0, pct: 83.3 },
		brief: { kind: 'weekly', from: LAST_WEEK, to: '2026-11-01', summary: 'A solid week.', findings }
	} as unknown as WeeklyReviewSnapshot;
	return {
		review: { id: ID, weekStartsOn: LAST_WEEK, revision: 1, summary: 'A solid week.' },
		legacy: false,
		snapshot,
		writeUp: { state: 'none' },
		proposal: null,
		decision: { state: 'none' },
		noProposal: null,
		notProposed: [],
		...parts
	} as WeeklyReviewView;
}

describe('the review key', () => {
	it('names a weekly review by its Monday, a cycle review by its id, or nothing', () => {
		expect(parseReviewKey(undefined)).toBeNull();
		expect(parseReviewKey(`w-${LAST_WEEK}`)).toEqual({ kind: 'weekly', weekStartsOn: LAST_WEEK });
		expect(parseReviewKey(`c-${ID}`)).toEqual({ kind: 'cycle', id: ID });
	});

	it('is malformed for a day that is not a Monday, a non-date, a bad id or another prefix', () => {
		for (const key of ['w-2026-10-27', 'w-2026-02-30', 'w-soon', 'c-123', `x-${LAST_WEEK}`, ''])
			expect(parseReviewKey(key), key).toBeUndefined();
	});
});

describe('the list', () => {
	it('with no review: this week in progress, then last week, due', () => {
		expect(reviewRows([], LAST_WEEK, TODAY)).toEqual([
			expect.objectContaining({
				state: 'in_progress',
				key: `w-${THIS_WEEK}`,
				title: 'Week of 2 Nov'
			}),
			expect.objectContaining({ state: 'due', key: `w-${LAST_WEEK}`, title: 'Week of 26 Oct' })
		]);
	});

	it('this week leads as due once every session is done or skipped', () => {
		const rows = reviewRows([], THIS_WEEK, TODAY);
		expect(rows.map((r) => [r.state, r.weekStartsOn])).toEqual([
			['due', THIS_WEEK],
			['not_reviewed', LAST_WEEK]
		]);
		expect(rows[0]!.text).toBe('Ready to review');
	});

	it('newest first, reviews with their summaries and the weeks between them not reviewed yet', () => {
		const reviews = [
			{ weekStartsOn: LAST_WEEK, summary: 'Last week.' },
			{ weekStartsOn: '2026-10-05', summary: 'Four weeks ago.' }
		];
		const rows = reviewRows(reviews, null, TODAY);
		expect(rows.map((r) => [r.state, r.weekStartsOn, r.text])).toEqual([
			['in_progress', THIS_WEEK, expect.stringContaining('ready after Sunday')],
			['reviewed', LAST_WEEK, 'Last week.'],
			['not_reviewed', '2026-10-19', 'Not reviewed yet'],
			['not_reviewed', '2026-10-12', 'Not reviewed yet'],
			['reviewed', '2026-10-05', 'Four weeks ago.']
		]);
	});

	it('lists at most NOT_REVIEWED_MAX older weeks with no review, and every review', () => {
		const old = '2025-11-03';
		const rows = reviewRows([{ weekStartsOn: old, summary: 'A year ago.' }], LAST_WEEK, TODAY);
		expect(rows.filter((r) => r.state === 'not_reviewed')).toHaveLength(NOT_REVIEWED_MAX);
		expect(rows.at(-1)).toMatchObject({ state: 'reviewed', weekStartsOn: old });
		expect(rows.slice(0, 2).map((r) => r.state)).toEqual(['in_progress', 'due']);
	});
});

describe('a verdict as its badge says it', () => {
	const with_ = (level: Finding['verdict']['level'], words: string, change: number | null = 1) =>
		findingVerdict(
			finding('verdicts:x', { verdict: { level, words }, figures: [figure('Change', change, '')] })
		);

	it('reads real trends, normal variation and too little data from the stored verdict', () => {
		expect(with_('good', 'Trending up, improving')).toEqual({
			verdict: 'real_trend',
			direction: 'up',
			good: true
		});
		expect(with_('watch', 'Trending down, declining', -3)).toEqual({
			verdict: 'real_trend',
			direction: 'down',
			good: false
		});
		expect(with_('neutral', 'Trending down', 2)).toEqual({
			verdict: 'real_trend',
			direction: 'down',
			good: null
		});
		expect(with_('neutral', 'Within normal variation')).toEqual({ verdict: 'normal_variation' });
		expect(with_('not_enough_data', 'Not enough data yet: 2 more weeks', null)).toEqual({
			verdict: 'insufficient_data',
			have: 4,
			need: 6,
			unit: 'weeks'
		});
		expect(with_('not_enough_data', 'Not enough data yet: 1 more week', null)).toMatchObject({
			have: 5
		});
		// Enough weeks over too short a span: never '6 of 6 weeks'.
		expect(with_('not_enough_data', 'Not enough data yet: 0 more weeks', null)).toMatchObject({
			have: 5
		});
	});
});

describe('a weekly review as the screen shows it', () => {
	it('the hero, planned against completed and each trend with its context, from the snapshot', () => {
		const data = weeklyReviewData(view());
		expect(data).toMatchObject({
			kind: 'weekly',
			key: `w-${LAST_WEEK}`,
			title: 'Week of 26 Oct',
			dates: 'Mon 26 Oct – Sun 1 Nov',
			summary: 'A solid week.',
			legacy: false,
			adherence: {
				pct: 83.3,
				text: '83%',
				level: 'good',
				words: '5 of 6 sessions done · On plan',
				counts: [
					{ label: 'Planned', value: 6, words: '6 sessions' },
					{ label: 'Completed', value: 5, words: '5 sessions' },
					{ label: 'Skipped', value: 1, words: '1 session' },
					{ label: 'Missed', value: 0, words: '0 sessions' }
				]
			},
			writeUp: null
		});
		expect(data.trends).toEqual([
			{
				id: BENCH.id,
				label: 'Bench press estimated 1RM',
				verdict: { verdict: 'real_trend', direction: 'up', good: true },
				words: 'Trending up, improving',
				change: '5 kg',
				context: {
					period: 'Trend over the last 9 weeks',
					good: METRICS.e1rm.good.words,
					method: METRICS.e1rm.method,
					caveat: METRICS.e1rm.caveat
				}
			},
			expect.objectContaining({
				id: TONNAGE.id,
				change: null,
				words: 'Not enough data yet: 2 more weeks'
			})
		]);
	});

	it('a baseline week is a note, not a trend; a written write-up is shown', () => {
		const baseline = finding('verdicts:baseline', {
			verdict: { level: 'neutral', words: 'This baseline week sets your starting point' }
		});
		const data = weeklyReviewData(
			view({ writeUp: { state: 'written', text: 'Well done.' } }, [ADHERENCE, baseline])
		);
		expect(data.trends).toEqual([]);
		expect(data.notes).toEqual([
			{
				id: 'verdicts:baseline',
				label: 'verdicts:baseline',
				words: 'This baseline week sets your starting point'
			}
		]);
		expect(data.writeUp).toBe('Well done.');
	});

	it('nothing due: no percentage, never a 0 %', () => {
		const none = finding('adherence', {
			figures: [figure('Planned', 0, '0 sessions'), figure('Adherence', null, 'No data', 'pct')],
			verdict: { level: 'neutral', words: 'Nothing planned or logged this week' }
		});
		const v = view({}, [none]);
		(v.snapshot!.adherence as { pct: number | null }).pct = null;
		expect(weeklyReviewData(v).adherence).toMatchObject({ pct: null, text: null });
	});

	it('a review written before M6 shows its summary alone', () => {
		const data = weeklyReviewData(view({ legacy: true, snapshot: null }));
		expect(data).toMatchObject({
			legacy: true,
			summary: 'A solid week.',
			adherence: null,
			trends: [],
			notes: []
		});
	});
});

describe('an out-of-date review', () => {
	const PROPOSAL = '0b7e2d4c-1a3f-4e5d-9c6b-8a7f6e5d4c3b';
	const stale = (state: WeeklyReviewView['decision']['state'], laterChanges = 3) =>
		weeklyReviewData(
			view({
				stale: true,
				laterChanges,
				decision: { state, proposalId: PROPOSAL } as WeeklyReviewView['decision']
			})
		).stale;

	it('says how many changes came after it, and offers Refresh while the decision is open', () => {
		expect(stale('undecided')).toEqual({
			words: 'Computed before 3 later changes',
			detail: 'You’ve logged training since. Refresh recomputes it and keeps this version.',
			refreshable: true
		});
		expect(stale('partly_past', 1)).toMatchObject({
			words: 'Computed before 1 later change',
			refreshable: true
		});
		expect(
			weeklyReviewData(view({ stale: true, laterChanges: 2, decision: { state: 'none' } })).stale
		).toMatchObject({ refreshable: true });
	});

	it('a decided review never changes: no Refresh once applied, rejected or superseded', () => {
		for (const state of ['applied', 'rejected', 'accepted_waiting', 'superseded'] as const)
			expect(stale(state), state).toMatchObject({
				detail: 'You’ve decided on its changes, so it stays as it was.',
				refreshable: false
			});
	});

	it('an up-to-date review shows no notice, and the id Refresh posts is the live revision', () => {
		const data = weeklyReviewData(view({ stale: false, laterChanges: 0 }));
		expect(data.stale).toBeNull();
		expect(data.id).toBe(ID);
	});
});

describe('Refresh', () => {
	const today = vi.fn(async () => TODAY);
	const refreshing = (outcome: () => Promise<unknown>) => {
		const refresh = vi.fn(outcome) as never;
		return { run: () => refreshReview('owner', ID, new Date(), { db, refresh, today }), refresh };
	};

	it('writes the next revision from today', async () => {
		const { run, refresh } = refreshing(async () => ({ id: 'next' }));
		await expect(run()).resolves.toEqual({ ok: true });
		expect(refresh).toHaveBeenCalledWith('owner', ID, { today: TODAY }, { db });
	});

	it('already up to date, or refreshed first by another tap, shows the live revision', async () => {
		for (const err of [new WeeklyReviewRefreshError('not_stale'), new ReviewSupersededError()])
			await expect(refreshing(async () => Promise.reject(err)).run(), err.message).resolves.toEqual(
				{ ok: true }
			);
	});

	it('a decided or not-yet-reviewable review is a 409, an unknown one a 400, and anything else fails', async () => {
		const decided = refreshing(async () => Promise.reject(new WeeklyReviewRefreshError('decided')));
		await expect(decided.run()).resolves.toEqual({
			ok: false,
			status: 409,
			data: { reason: 'decided' }
		});
		// An early review whose week is no longer all done waits for Monday, as Create does.
		const early = refreshing(async () =>
			Promise.reject(new WeeklyReviewNotReviewableError('2026-11-09'))
		);
		await expect(early.run()).resolves.toEqual({
			ok: false,
			status: 409,
			data: { reason: 'not_ready' }
		});
		const gone = refreshing(async () => Promise.reject(new ReviewNotFoundError()));
		await expect(gone.run()).resolves.toEqual({
			ok: false,
			status: 400,
			data: { reason: 'invalid' }
		});
		const boom = new Error('db down');
		await expect(refreshing(async () => Promise.reject(boom)).run()).rejects.toBe(boom);
	});
});

describe('the load', () => {
	const page = {
		items: [
			{
				kind: 'weekly',
				id: ID,
				startsOn: LAST_WEEK,
				endsOn: '2026-11-01',
				revision: 1,
				summary: 'A solid week.',
				legacy: false
			},
			{
				kind: 'cycle',
				id: 'c1',
				startsOn: '2026-10-05',
				endsOn: '2026-11-01',
				revision: 1,
				summary: 'Block.',
				legacy: false
			}
		],
		next: null
	};

	function deps(parts: Partial<ReviewsDeps> = {}) {
		const calls: string[] = [];
		const track = <T>(name: string, value: T) =>
			vi.fn(async () => {
				calls.push(`${name}:start`);
				await new Promise((r) => setTimeout(r, 1));
				calls.push(`${name}:end`);
				return value;
			});
		const d = {
			db,
			today: track('today', TODAY),
			list: track('list', page),
			reviewable: track('reviewable', { weekStartsOn: THIS_WEEK, reason: 'all_done' }),
			view: track('view', view()),
			record: vi.fn(async () => null),
			...parts
		} as unknown as Required<ReviewsDeps>;
		return { d, calls };
	}

	it('the list and the selected review, reading one query at a time', async () => {
		const { d, calls } = deps();
		const data = await loadReviews('owner', { key: `w-${LAST_WEEK}`, origin }, new Date(), d);
		expect(data).toMatchObject({ failed: false, key: `w-${LAST_WEEK}`, empty: false });
		if (data.failed) throw new Error('unreachable');
		// The cycle review waits for its screen (cycle-review-screen): only weekly rows.
		expect(data.rows.map((r) => [r.state, r.weekStartsOn])).toEqual([
			['due', THIS_WEEK],
			['reviewed', LAST_WEEK]
		]);
		expect(data.selected).toMatchObject({
			kind: 'weekly',
			key: `w-${LAST_WEEK}`,
			title: 'Week of 26 Oct'
		});
		expect(d.view).toHaveBeenCalledWith('owner', LAST_WEEK, { db });
		expect(d.list).toHaveBeenCalledWith('owner', { limit: 50 }, { db });
		expect(d.reviewable).toHaveBeenCalledWith('owner', TODAY, { db });
		for (let i = 0; i < calls.length; i += 2)
			expect(calls[i + 1]).toBe(calls[i]!.replace('start', 'end'));
	});

	it("an open decision reads the head's changes on the owner's today; a decided one none", async () => {
		const head = '0b7e2d4c-1a3f-4e5d-9c6b-8a7f6e5d4c3b';
		const offer = {
			id: 'load:a:2',
			sessionDate: '2026-11-03',
			why: 'Felt easier',
			halfStep: null,
			ahead: false
		};
		const open = view({
			decision: { state: 'undecided', proposalId: head },
			proposal: {
				id: head,
				rows: [{ label: 'Bench', before: '85 kg', after: '87.5 kg', date: null }]
			}
		} as unknown as Partial<WeeklyReviewView>);
		const { d } = deps({
			view: vi.fn(async () => open),
			offers: vi.fn(async () => [offer])
		});
		const data = await loadReviews('owner', { key: `w-${LAST_WEEK}`, origin }, new Date(), d);
		if (data.failed) throw new Error('unreachable');
		expect(d.offers).toHaveBeenCalledWith('owner', head, TODAY, { db });
		expect(data.selected?.nextWeek).toMatchObject({
			state: 'all_past',
			items: [{ id: 'load:a:2', label: 'Bench', passed: 'Tuesday has passed' }]
		});

		const decided = view({
			decision: { state: 'rejected', proposalId: head }
		} as Partial<WeeklyReviewView>);
		const again = deps({ view: vi.fn(async () => decided), offers: vi.fn(async () => [offer]) });
		await loadReviews('owner', { key: `w-${LAST_WEEK}`, origin }, new Date(), again.d);
		expect(again.d.offers).not.toHaveBeenCalled();
	});

	it('no key: the list alone, empty with no review stored', async () => {
		const { d } = deps({ list: vi.fn(async () => ({ items: [], next: null })) });
		const data = await loadReviews('owner', { key: undefined, origin }, new Date(), d);
		expect(data).toMatchObject({ failed: false, key: null, empty: true, selected: null });
		expect(d.view).not.toHaveBeenCalled();
	});

	it('a malformed key or a cycle key is a 404 before anything is read', async () => {
		for (const key of ['w-2026-10-27', 'nope', `c-${ID}`]) {
			const { d } = deps();
			const caught = await loadReviews('owner', { key, origin }, new Date(), d).catch(
				(e: unknown) => e
			);
			expect(isHttpError(caught, 404), key).toBe(true);
			expect(d.list).not.toHaveBeenCalled();
			expect(d.record).not.toHaveBeenCalled();
		}
	});

	it('a week with no review is a 404, never a recorded failure', async () => {
		const { d } = deps({ view: vi.fn(async () => Promise.reject(new ReviewNotFoundError())) });
		const caught = await loadReviews(
			'owner',
			{ key: `w-${THIS_WEEK}`, origin },
			new Date(),
			d
		).catch((e: unknown) => e);
		expect(isHttpError(caught, 404)).toBe(true);
		expect(d.record).not.toHaveBeenCalled();
	});

	it('a failed read is recorded and becomes the load-failed state', async () => {
		const boom = new Error('db down');
		const { d } = deps({ list: vi.fn(async () => Promise.reject(boom)) });
		const data = await loadReviews('owner', { key: undefined, origin }, new Date(), d);
		expect(data).toEqual({ failed: true, key: null });
		expect(d.record).toHaveBeenCalledWith(
			expect.objectContaining({
				error: boom,
				kind: 'load',
				status: 500,
				...origin,
				context: { load: 'progress-reviews', key: null }
			}),
			{ db: undefined }
		);
	});
});

describe('Create', () => {
	const today = vi.fn(async () => TODAY);
	const stored = { review: { weekStartsOn: LAST_WEEK }, created: true };

	it('opens the week’s review, created now or already there', async () => {
		const create = vi.fn(async () => stored) as never;
		await expect(
			createReview('owner', LAST_WEEK, new Date(), { db, create, today })
		).resolves.toEqual({
			ok: true,
			key: `w-${LAST_WEEK}`
		});
		expect(create).toHaveBeenCalledWith('owner', { weekStartsOn: LAST_WEEK, today: TODAY }, { db });
	});

	it('a week not reviewable yet is a 409 with the day it will be', async () => {
		const create = vi.fn(async () =>
			Promise.reject(new WeeklyReviewNotReviewableError('2026-11-09'))
		) as never;
		await expect(
			createReview('owner', THIS_WEEK, new Date(), { db, create, today })
		).resolves.toEqual({
			ok: false,
			status: 409,
			data: {
				reason: 'not_reviewable',
				weekStartsOn: THIS_WEEK,
				availableOn: '2026-11-09',
				ready: 'Ready Mon 9 Nov'
			}
		});
	});

	it('a week that is not one is a 400; anything else fails the request', async () => {
		const invalid = vi.fn(async () =>
			Promise.reject(new ReviewInputError('weekStartsOn', 'A review starts on a Monday'))
		) as never;
		await expect(
			createReview('owner', 'soon', new Date(), { db, create: invalid, today })
		).resolves.toMatchObject({
			ok: false,
			status: 400,
			data: { reason: 'invalid' }
		});
		const boom = new Error('db down');
		const failing = vi.fn(async () => Promise.reject(boom)) as never;
		await expect(
			createReview('owner', LAST_WEEK, new Date(), { db, create: failing, today })
		).rejects.toBe(boom);
	});
});
