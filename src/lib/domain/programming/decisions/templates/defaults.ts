/**
 * What the coach assumed and what it left out (m3/13): a 'not told yet' default, whose facts
 * assumptionFacts (../../rules/defaults.ts) gives, and a paused goal.
 */
import type { Templates } from '../../decisions.ts';

export const defaults = {
	default_assumed: {
		summary: 'Assumed {assumed}',
		why: '{missing} The coach assumed {assumed}. {rationale} Change it in Profile → {section}.'
	},
	goal_excluded: {
		summary: '{goal} is paused',
		why: '{goal} is paused, so it does not shape this program. Resume it in Profile → Your goals, and the next program plans for it.'
	}
} as const satisfies Templates;
