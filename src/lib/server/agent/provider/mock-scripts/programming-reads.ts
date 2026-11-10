/**
 * The mock coach's scripts for the programming reads. Each answer is computed from the turn's
 * tool results, so it states only what the tools returned, and quotes stored text as it was
 * stored:
 * - 'Why am I doing this exercise?' reads this week and the program's history, then quotes the
 *   newest decision's why, word for word, citing the decision.
 * - The turn after a rejection ('I rejected that…') reads the rejected proposal by the id the turn
 *   context lists (the newest rejected one when it lists none) and acknowledges the owner's reason.
 * - 'What did you propose?' reads the newest proposals and says who proposed each: the coach, or a
 *   review's rules, citing the review, so a review's proposal is never presented as the coach's.
 */
import type { MockContext, MockScript } from '../mock.ts';

const WHY = /\bwhy (am i|do i|are we|is)\b.*\b(doing|in my|this)\b/i;
const REJECTED = /\b(i )?(rejected|declined|turned down|said no to)\b/i;
const PROPOSED = /\bwhat (did|have) you (proposed?|suggested?)\b/i;

interface Wrapped {
	untrusted_text: string;
}
interface HistoryResult {
	versions: {
		number: number;
		decisions: { source: { id: string }; summary: Wrapped; why: Wrapped }[];
	}[];
}
interface ProposalsResult {
	items: {
		source: { id: string };
		title: Wrapped;
		status: string;
		decisionNote: Wrapped | null;
		origin: 'coach' | 'weekly_review' | 'cycle_review';
		review: { id: string; label?: string } | null;
	}[];
}

/** Who made a review's proposal, in the answer's words. */
const PROPOSER = { weekly_review: 'Your weekly review', cycle_review: 'Your cycle review' };

/** The rejected proposals the turn context lists, by id. */
function rejectedIds(context: MockContext): string[] {
	const listed = (context.turnContext?.decidedProposals ?? []) as { id: string; status: string }[];
	return listed.filter((p) => p.status === 'rejected').map((p) => p.id);
}

function whyAnswer(context: MockContext): string {
	const history = context.result('get_program_history') as HistoryResult;
	const decision = history.versions.flatMap((v) => v.decisions)[0];
	if (!decision)
		return '[note] Your program history doesn’t record a reason for that yet, so I can’t tell you why it was planned.';
	const label = decision.summary.untrusted_text.replace(/[[\]|\n]/g, ' ').slice(0, 80);
	return `It’s in your plan for the reason recorded when it was decided.\n\n[fact] “${decision.why.untrusted_text}” [[decision:${decision.source.id}|${label}]]`;
}

function rejectionAnswer(context: MockContext): string {
	const { items } = context.result('get_coach_proposals') as ProposalsResult;
	const proposal = items.find((p) => p.status === 'rejected');
	if (!proposal) return '[note] I don’t see a proposal you’ve turned down, so nothing changes.';
	const reason = proposal.decisionNote
		? ` because “${proposal.decisionNote.untrusted_text}”`
		: ', without a reason';
	return `[note] Understood: you turned down “${proposal.title.untrusted_text}”${reason} [[proposal:${proposal.source.id}]]. I won’t propose that change again unless you ask for it.`;
}

function proposedAnswer(context: MockContext): string {
	const { items } = context.result('get_coach_proposals') as ProposalsResult;
	if (items.length === 0) return '[note] Nothing has been proposed to you yet.';
	const lines = items.map((p) => {
		const title = p.title.untrusted_text.replace(/[[\]|\n]/g, ' ');
		const proposal = `[[proposal:${p.source.id}]]`;
		if (p.origin === 'coach' || !p.review)
			return `[fact] I proposed “${title}” (${p.status}) ${proposal}`;
		const review = `[[review:${p.review.id}|${p.review.label ?? 'Review'}]]`;
		return `[fact] ${PROPOSER[p.origin]} proposed “${title}” (${p.status}), not me ${proposal} ${review}`;
	});
	return ['Here is what has been proposed lately.', ...lines].join('\n\n');
}

export const programmingReadScripts: readonly MockScript[] = [
	{
		name: 'why-this-exercise',
		matches: (text) => WHY.test(text),
		steps: [
			{
				tools: [
					{ name: 'get_current_training_week', input: {} },
					{ name: 'get_program_history', input: {} }
				]
			},
			{ text: whyAnswer }
		]
	},
	{
		name: 'after-rejection',
		matches: (text) => REJECTED.test(text),
		steps: [
			{
				tools: [
					{
						name: 'get_coach_proposals',
						input: (context) => {
							const ids = rejectedIds(context);
							return ids.length > 0 ? { ids } : { status: 'rejected', limit: 1 };
						}
					}
				]
			},
			{ text: rejectionAnswer }
		]
	},
	{
		name: 'what-did-you-propose',
		matches: (text) => PROPOSED.test(text),
		steps: [{ tools: [{ name: 'get_coach_proposals', input: {} }] }, { text: proposedAnswer }]
	}
];
