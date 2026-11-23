import { describe, expect, it } from 'vitest';
import { replanCopy, type ReplanLinks } from './replan-notice.ts';

const links: ReplanLinks = {
	proposal: (id) => `/coach/proposals/${id}`,
	today: '/today'
};

/** A state's whole sentence, its link's words in place. */
const sentence = (copy: ReturnType<typeof replanCopy>) =>
	`${copy.before}${copy.link?.label ?? ''}${copy.after}`;

describe('the re-plan notice’s copy, by state', () => {
	it('offers the re-plan to review, linked to its proposal', () => {
		const copy = replanCopy({ state: 'proposed', proposalId: 'p-1' }, links);
		expect(sentence(copy)).toBe('Your plan can follow these priorities · Review the re-plan');
		expect(copy.link).toEqual({ label: 'Review the re-plan', href: '/coach/proposals/p-1' });
		expect(copy.retry).toBe(false);
	});

	it('says the plan already fits these priorities, with no link', () => {
		const copy = replanCopy({ state: 'unchanged' }, links);
		expect(sentence(copy)).toBe('Your plan already fits these priorities');
		expect(copy.link).toBeUndefined();
		expect(copy.retry).toBe(false);
	});

	it('says the next block will follow these priorities, with no link', () => {
		const copy = replanCopy({ state: 'deferred' }, links);
		expect(sentence(copy)).toBe('Your next block will follow these priorities');
		expect(copy.link).toBeUndefined();
		expect(copy.retry).toBe(false);
	});

	it('asks for a program from Today, the link inside the sentence', () => {
		const copy = replanCopy({ state: 'no_program' }, links);
		expect(sentence(copy)).toBe(
			'Build your program from Today, and it will follow these priorities'
		);
		expect(copy.before).toBe('Build your program from ');
		expect(copy.link).toEqual({ label: 'Today', href: '/today' });
		expect(copy.after).toBe(', and it will follow these priorities');
		expect(copy.retry).toBe(false);
	});

	it('says a re-plan could not be prepared, and offers Retry', () => {
		const copy = replanCopy({ state: 'failed' }, links);
		expect(sentence(copy)).toBe('Couldn’t prepare a re-plan for these priorities');
		expect(copy.link).toBeUndefined();
		expect(copy.retry).toBe(true);
	});

	it('never reads as a failure in a state that is not one', () => {
		for (const replan of [
			{ state: 'proposed', proposalId: 'p-1' },
			{ state: 'unchanged' },
			{ state: 'deferred' },
			{ state: 'no_program' }
		] as const) {
			expect(sentence(replanCopy(replan, links))).not.toMatch(/fail|error|couldn|warning/i);
		}
	});
});
