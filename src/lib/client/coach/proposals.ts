/**
 * Accept on a proposal card (POST /api/coach/proposals/[id]): only the id and the action go, so
 * what is applied is always the stored proposal. The proposal comes back as it now stands
 * (applied, accepted, or superseded when the program moved on), and the card shows that.
 */
import { parseCard, type ProposalCardView } from '#lib/domain/coach/cards.ts';

type Fetch = typeof globalThis.fetch;

/**
 * The card as the server answered: 200 when it went through (or had already), 409 when it was
 * superseded or decided another way. Null when there is no proposal to show: offline, a refusal,
 * a failure, or one that is not the owner's.
 */
export async function acceptProposal(
	id: string,
	fetch: Fetch = globalThis.fetch
): Promise<ProposalCardView | null> {
	try {
		const response = await fetch(`/api/coach/proposals/${encodeURIComponent(id)}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ action: 'accept' })
		});
		if (response.status !== 200 && response.status !== 409) return null;
		const body = (await response.json()) as { proposal?: unknown };
		const card = parseCard(body.proposal);
		return card?.id === id ? card : null;
	} catch {
		return null;
	}
}
