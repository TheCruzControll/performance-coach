/**
 * Accept and Reject on a proposal card (POST /api/coach/proposals/[id]): only the id, the action
 * and a rejection's reason go, so what is decided is always the stored proposal. The proposal
 * comes back as it now stands (applied, accepted, rejected, or superseded when the program moved
 * on), and the card shows that.
 *
 * Sending the same decision again is safe: the server answers a decided proposal as stored and
 * writes nothing, so a Retry after a failure, or after a request cut off once the server had
 * applied it, shows the outcome and never applies it twice.
 */
import { parseCard, type ProposalCardView } from '#lib/domain/coach/cards.ts';

type Fetch = typeof globalThis.fetch;

export type Decision = { action: 'accept' } | { action: 'reject'; reason: string | null };

export type DecisionResult =
	/** 200 when it went through (or had already), 409 when superseded or decided another way. */
	| { kind: 'decided'; card: ProposalCardView }
	/**
	 * Nothing to show: `retry` when sending it again may work (offline, a dropped connection, a
	 * server failure, an answer cut off); otherwise a refusal, or a proposal that is not the
	 * owner's.
	 */
	| { kind: 'failed'; retry: boolean };

export async function decideProposal(
	id: string,
	decision: Decision,
	fetch: Fetch = globalThis.fetch
): Promise<DecisionResult> {
	let response: Response;
	try {
		response = await fetch(`/api/coach/proposals/${encodeURIComponent(id)}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(decision)
		});
	} catch {
		return { kind: 'failed', retry: true };
	}
	if (response.status >= 500) return { kind: 'failed', retry: true };
	if (response.status !== 200 && response.status !== 409) return { kind: 'failed', retry: false };
	try {
		const body = (await response.json()) as { proposal?: unknown };
		const card = parseCard(body.proposal);
		if (card?.id === id) return { kind: 'decided', card };
	} catch {
		// The answer was cut off or replaced on the way: the server may have decided it.
	}
	return { kind: 'failed', retry: response.status === 200 };
}
