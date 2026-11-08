/**
 * M7's re-plans (replan-domain rewords it). `change` names what the new version does; `reason`
 * is a whole sentence.
 */
import type { Templates } from '../../decisions.ts';

export const periodisationReplan = {
	replanned: {
		summary: 'Re-planned from {from}: {change}',
		why: '{who} re-planned from {from}: {change}. The weeks before it stay as they were. {reason}'
	}
} as const satisfies Templates;
