/**
 * The words of Profile's re-plan notice (ReplanNotice.svelte): what the priority trigger did after
 * a goal change, by its state (services/periodisation/priority.ts). The ui layer may not import
 * the server, so the states are named here, as the goal actions send them.
 *
 * Calm, never a warning tone: each state says what the plan does with the priorities. A state's
 * sentence is `before`, then the link (when it has one), then `after`, so the link sits in the
 * sentence it belongs to.
 */

/** What the trigger did for the owner's goals. */
export type ReplanState = 'proposed' | 'unchanged' | 'deferred' | 'no_program' | 'failed';

/** A goal action's `replan`, or the Retry's: a re-plan to review carries its proposal's id. */
export type ReplanResult =
	{ state: 'proposed'; proposalId: string } | { state: Exclude<ReplanState, 'proposed'> };

/** A state's sentence: its text, a link inside it, and the text after the link. */
export interface ReplanCopy {
	before: string;
	link?: { label: string; href: string };
	after: string;
	/** failed: the notice offers Retry. */
	retry: boolean;
}

/** Where a state's link goes: a proposal's page by its id, and Today. */
export interface ReplanLinks {
	proposal: (id: string) => string;
	today: string;
}

/** The copy of `replan`'s state, word for word. */
export function replanCopy(replan: ReplanResult, links: ReplanLinks): ReplanCopy {
	switch (replan.state) {
		case 'proposed':
			return {
				before: 'Your plan can follow these priorities · ',
				link: { label: 'Review the re-plan', href: links.proposal(replan.proposalId) },
				after: '',
				retry: false
			};
		case 'unchanged':
			return { before: 'Your plan already fits these priorities', after: '', retry: false };
		case 'deferred':
			return { before: 'Your next block will follow these priorities', after: '', retry: false };
		case 'no_program':
			return {
				before: 'Build your program from ',
				link: { label: 'Today', href: links.today },
				after: ', and it will follow these priorities',
				retry: false
			};
		case 'failed':
			return {
				before: 'Couldn’t prepare a re-plan for these priorities',
				after: '',
				retry: true
			};
	}
}
