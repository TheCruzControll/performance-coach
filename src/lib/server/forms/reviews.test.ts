/**
 * decideReview's routing of the next-week card's post (forms/reviews.ts): Accept on a deload
 * posts `accept` with no change ticked and reaches the service's head-based accept; Keep and a
 * decide with changes are routed as before. The service is mocked, so only the form is under test
 * (its own rules are in tests/integration/reviews).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { decideNextWeek, ReviewInputError, WHOLE_ONLY } from '../services/reviews/index';
import type * as Programs from '../services/programs/index';
import type * as Reviews from '../services/reviews/index';
import { decideReview, NOTHING_TICKED } from './reviews';

vi.mock('../services/reviews/index', async (importOriginal) => {
	const actual = await importOriginal<typeof Reviews>();
	return { ...actual, decideNextWeek: vi.fn() };
});
vi.mock('../services/programs/index', async (importOriginal) => {
	const actual = await importOriginal<typeof Programs>();
	return { ...actual, getCurrentProgram: vi.fn(async () => null) };
});

const OWNER = 'owner-1';
const REVIEW = 'review-1';
const WEEK = '2026-11-16';

/** A FormData from name → value, or values, in the order given. */
function form(fields: Record<string, string | string[]>): FormData {
	const data = new FormData();
	for (const [name, value] of Object.entries(fields))
		for (const v of [value].flat()) data.append(name, v);
	return data;
}

const decide = (fields: Record<string, string | string[]>, mode: 'decide' | 'keep' = 'decide') =>
	decideReview(OWNER, { form: form({ reviewId: REVIEW, ...fields }), mode, weekStartsOn: WEEK });

beforeEach(() => {
	vi.mocked(decideNextWeek).mockReset();
});

describe('decideReview routes the next-week card', () => {
	it('Accept on a deload posts accept with no change ticked, and is applied as one version', async () => {
		vi.mocked(decideNextWeek).mockResolvedValue({
			outcome: 'applied',
			proposalId: 'p-1',
			versionId: 'v-2',
			versionNumber: 2,
			passed: 0
		});

		const result = await decide({ accept: 'deload' });

		expect(decideNextWeek).toHaveBeenCalledWith(OWNER, REVIEW, { items: [], accept: true }, {});
		expect(result).toEqual({
			outcome: 'applied',
			words: 'Next week updated · version 2',
			href: '/train'
		});
	});

	it('the service refusing a ticked change on a deload comes back as a 400 with its words', async () => {
		vi.mocked(decideNextWeek).mockRejectedValue(new ReviewInputError('items', WHOLE_ONLY));

		const result = await decide({ accept: 'deload', item: 'op:0', 'choice:op:0': 'proposed' });

		expect(result).toMatchObject({ status: 400, data: { reason: 'invalid', message: WHOLE_ONLY } });
	});

	it('Keep on a deload posts ?/keep: the note, and no accept', async () => {
		vi.mocked(decideNextWeek).mockResolvedValue({ outcome: 'rejected', proposalId: 'p-1' });

		const result = await decide({ accept: 'deload', note: ' Feeling fine ' }, 'keep');

		expect(decideNextWeek).toHaveBeenCalledWith(
			OWNER,
			REVIEW,
			{ items: [], note: 'Feeling fine' },
			{}
		);
		expect(result).toEqual({ outcome: 'rejected' });
	});

	it('a decide with nothing ticked and no accept is refused before the service', async () => {
		const result = await decide({});

		expect(result).toMatchObject({
			status: 400,
			data: { reason: 'invalid', message: NOTHING_TICKED }
		});
		expect(decideNextWeek).not.toHaveBeenCalled();
	});

	it('changes ticked and no accept are routed as one by one choices, as before', async () => {
		vi.mocked(decideNextWeek).mockResolvedValue({ outcome: 'rejected', proposalId: 'p-1' });

		await decide({ item: ['op:0', 'op:1'], 'choice:op:1': 'half_step' });

		expect(decideNextWeek).toHaveBeenCalledWith(
			OWNER,
			REVIEW,
			{
				items: [
					{ id: 'op:0', choice: 'proposed' },
					{ id: 'op:1', choice: 'half_step' }
				]
			},
			{}
		);
	});
});
