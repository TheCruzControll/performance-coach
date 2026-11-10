/**
 * The mock coach's thread summary (agent/rollover.ts): the summary call's user message starts with
 * SUMMARY_REQUEST_HEADER and carries the segment as data, which holds the owner's own words, so
 * this script comes first and matches the header alone. The summary is built from the data, so the
 * same segment always gets the same summary: how many messages the owner sent, the first and the
 * last of them.
 */
import { SUMMARY_REQUEST_HEADER } from '../../prompt/summary.ts';
import type { MockContext, MockScript } from '../mock.ts';

/** The most characters of an owner message the mock summary quotes. */
const QUOTE_CHARS = 120;

interface Item {
	from: 'owner' | 'coach';
	text?: { untrusted_text: string };
}

function ownerWords(context: MockContext): string[] {
	const json = context.ownerText.slice(SUMMARY_REQUEST_HEADER.length);
	const { conversation } = JSON.parse(json) as { conversation: Item[] };
	return conversation.flatMap((item) =>
		item.from === 'owner' && item.text
			? [Array.from(item.text.untrusted_text).slice(0, QUOTE_CHARS).join('')]
			: []
	);
}

export const summaryScripts: readonly MockScript[] = Object.freeze([
	{
		name: 'thread-summary',
		matches: (text) => text.startsWith(SUMMARY_REQUEST_HEADER),
		steps: [
			{
				json: (context: MockContext) => {
					const words = ownerWords(context);
					return {
						summary: `The owner sent ${words.length} messages, starting with “${words[0] ?? ''}”.`,
						agreed: [],
						ownerSaid: words.length > 1 ? [words.at(-1)!] : [],
						openQuestions: []
					};
				}
			}
		]
	}
]);
