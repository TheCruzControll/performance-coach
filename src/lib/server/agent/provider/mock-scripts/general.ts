/**
 * The mock coach's general answers, tried after every group's scripts: a greeting, and an honest
 * answer for anything no other script covers. Neither calls a tool, so neither states a fact.
 */
import type { MockScript } from '../mock.ts';

const GREETING = /^\s*(hi|hello|hey|good (morning|afternoon|evening))\b/i;

export const generalScripts: readonly MockScript[] = [
	{
		name: 'greeting',
		matches: (text) => GREETING.test(text),
		steps: [
			{
				text: 'Hi, I’m your coach. Ask me about today’s session, your program or how a lift is going, and I’ll answer from what you’ve logged.'
			}
		]
	},
	{
		name: 'no-data',
		matches: () => true,
		steps: [
			{
				text: '[note] I don’t have data for that yet. Once it’s in your log, ask me again and I’ll answer from your records.'
			}
		]
	}
];
